/**
 * app.js — Hilo principal CRM Enterprise
 * Layout: top-nav + kpi-bar + toolbar + tabla-full + drawer lateral + bottom-bar
 */

import {
  initDB, addContactsBatch, queryFiltered, getContactById,
  updateContactStatus, incrementPurchaseCount,
  addHistory, getHistoryForContact,
  isOptOut, getKPIs, incrementKPI, resetKPIs,
  recalculateKPIs, clearAllData, exportFilteredStream,
  listTemplates, saveTemplate, dedupePassByPhone,
} from './db.js';

import {
  normalizeRUT, formatRUT,
  renderTemplate, buildSMSLink, buildWALink, downloadBlobStream,
  fmtNum, fmtTs, showToast, generateSyntheticCSV,
} from './utils.js';

// Storage (OPFS) — dynamic import so a failure here never breaks the app
let storage = null;
async function loadStorage() {
  if (storage) return storage;
  try {
    storage = await import('./storage.js');
    return storage;
  } catch(e) {
    console.warn('[CRM] storage.js no disponible:', e.message);
    return null;
  }
}

// getAllContacts and restoreBatch — loaded dynamically from db.js
// so older cached versions of db.js don't break the app
async function getAllContactsDynamic(onChunk) {
  // Try to use getAllContacts from db.js if available
  try {
    const mod = await import('./db.js');
    if (typeof mod.getAllContacts === 'function') {
      return await mod.getAllContacts(onChunk);
    }
  } catch(e) {}

  // Fallback: paginate through contacts using queryFiltered
  // exportFilteredStream returns CSV strings, NOT objects — don't use it here
  const PAGE = 5000;
  let offset = 0;
  let total  = 0;
  while (true) {
    const rows = await queryFiltered({}, PAGE + 1, offset);
    const hasMore = rows.length > PAGE;
    const batch   = hasMore ? rows.slice(0, PAGE) : rows;
    if (batch.length === 0) break;
    onChunk(batch);
    total  += batch.length;
    offset += PAGE;
    if (!hasMore) break;
  }
  return total;
}

async function restoreBatchDynamic(contacts) {
  try {
    const mod = await import('./db.js');
    if (typeof mod.restoreBatch === 'function') {
      return await mod.restoreBatch(contacts);
    }
  } catch(e) {}
  // Fallback: use addContactsBatch
  return await addContactsBatch(contacts, true);
}

/* ── Config ──────────────────────────────────────────────────── */
const CFG = {
  PAGE_SIZE:       100,   // filas por página
  BATCH_SIZE:      800,
  BATCH_DELAY_MS:  15,
  WORKER_RETRIES:  3,
  RETRY_BACKOFF:   300,
  FAST_IMPORT:     true,
  DRIP_BLOCK:      25,
};

/* ── Estados ─────────────────────────────────────────────────── */
const STS = {
  pending:    { label:'Sin contactar', cls:'st-pending'    },
  contacted:  { label:'Contactado',    cls:'st-contacted'  },
  responded:  { label:'Respondió',     cls:'st-responded'  },
  purchased:  { label:'Compró',        cls:'st-purchased'  },
  noresponse: { label:'Sin respuesta', cls:'st-noresponse' },
  optout:     { label:'Dado de baja',  cls:'st-optout'     },
};

/* ── State ───────────────────────────────────────────────────── */
let worker, workerAvailable = false;
let filter    = { q: '', status: '' };
let page      = 1;
let pageRows  = [];
let selectedIds = new Set();
let templates = [];
let dripQueue = [], dripActive = false;
let importQueue = [], insertingBatch = false;
let activeRowId = null;

const $ = id => document.getElementById(id);

/* ── Boot ────────────────────────────────────────────────────── */
async function boot() {
  ilog('Iniciando…');
  try {
    await initDB();
    $('dbStatus').textContent = '● online';
    $('dbStatus').style.color = 'var(--green)';
    ilog('DB lista');
  } catch(e) {
    toast('Error DB: ' + e.message, 'error'); return;
  }

  try {
    worker = new Worker('./worker-parser.js');
    worker.onmessage = onWorkerMsg;
    worker.onerror   = e => { logErr('Worker: ' + e.message); };
    workerAvailable  = true;
    ilog('Worker OK');
  } catch(e) {
    logWarn('Worker no disponible');
  }

  // Request persistent storage to prevent browser from evicting data
  const s = await loadStorage();
  if (s && navigator.storage?.persist) {
    const granted = await s.requestPersistentStorage();
    if (granted) ilog('Almacenamiento persistente: OK');
  }

  bindUI();
  await refreshKPIs();

  // Check if DB is empty and OPFS snapshot exists -> auto-restore
  const kpis = await getKPIs();
  if ((kpis.total || 0) === 0 && s && s.isOPFSAvailable()) {
    const meta = await s.readOPFSMeta();
    if (meta && meta.total > 0) {
      await promptOPFSRestore(meta);
    }
  }

  await loadPage(1);
  await refreshTemplates();
  await updateStorageInfo();
  ilog('Listo');
}

/* ── Bind UI ─────────────────────────────────────────────────── */
function bindUI() {
  $('btnUpload').onclick       = () => $('fileInput').click();
  $('fileInput').onchange      = onFileSelect;
  $('btnExport').onclick       = doExport;
  $('btnTemplates').onclick    = () => $('templatesModal').classList.remove('hidden');
  $('btnCloseTpl').onclick     = () => $('templatesModal').classList.add('hidden');
  $('btnSaveTpl').onclick      = doSaveTemplate;
  $('btnDedupe').onclick       = doDedupe;
  $('btnClearData').onclick    = doClear;
  $('btnGenSynthetic').onclick = doSynthetic;
  $('btnPreviewLinks').onclick = doPreviewLinks;
  $('btnStartDrip').onclick    = doStartDrip;
  $('btnSelectAll').onclick    = () => {
    pageRows.forEach(r => selectedIds.add(r.id));
    renderTable(pageRows);
    updateSel();
  };
  $('btnCloseDrawer').onclick = closeDrawer;
  $('btnPrevPage').onclick    = () => loadPage(page - 1);
  $('btnNextPage').onclick    = () => loadPage(page + 1);

  // OPFS / Backup buttons
  if ($('btnSaveSnapshot'))  $('btnSaveSnapshot').onclick  = doSaveSnapshot;
  if ($('btnExportBackup'))  $('btnExportBackup').onclick  = doExportBackup;
  if ($('btnImportBackup'))  $('btnImportBackup').onclick  = () => $('backupFileInput').click();
  if ($('backupFileInput'))  $('backupFileInput').onchange = doImportBackup;

  // Busqueda con debounce 300ms
  let t;
  $('searchInput').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { filter.q = $('searchInput').value.trim(); loadPage(1); }, 300);
  });
  $('statusFilter').addEventListener('change', () => {
    filter.status = $('statusFilter').value; loadPage(1);
  });
}

/* ── Import ──────────────────────────────────────────────────── */
async function onFileSelect(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  e.target.value = '';
  showProg(true);
  for (let i = 0; i < files.length; i++) {
    ilog(`▶ ${files[i].name} (${fmtSize(files[i].size)})`);
    await importFile(files[i], i);
  }
}

function importFile(file, idx) {
  return new Promise((resolve, reject) => {
    if (!workerAvailable) { fallbackImport(file, resolve, reject); return; }
    worker._res = worker._res || {};
    worker._res[idx] = { resolve, reject };
    worker.postMessage({ cmd:'parse', file, batchSize: CFG.BATCH_SIZE, fileIdx: idx });
  });
}

function onWorkerMsg(e) {
  const m = e.data;
  if (m.type === 'batch') {
    importQueue.push(m.rows);
    if (!insertingBatch) drainQueue();
  }
  if (m.type === 'progress') updateProg(m);
  if (m.type === 'done') {
    const { fileIndex, total, inserted, duplicates, filtered: filt } = m;

    // 1. Barra al 100% inmediatamente — el parsing terminó
    $('progressBar').style.width = '100%';
    $('progressPct').textContent = '100%';
    $('progressText').textContent =
      `Parsing completo: ${fmtNum(total)} filas · ${fmtNum(inserted)} únicos · ${fmtNum(duplicates)} dup · ${fmtNum(filt)} excluidos`;
    ilog(`✓ Parsing: ${fmtNum(total)} filas | ${fmtNum(inserted)} únicos`);

    // 2. Esperar que la cola de inserción vacíe (con feedback)
    waitEmpty(msg => { $('progressText').textContent = msg; }).then(async () => {

      // 3. Recalcular KPIs (cursor scan — puede tardar con 500k+ registros)
      $('progressBar').classList.add('indeterminate');
      $('progressText').textContent = `Recalculando estadísticas… (puede tardar con muchos contactos)`;
      $('progressPct').textContent = '…';
      ilog('Recalculando KPIs…');

      const kpis = await recalculateKPIs();

      // 4. Auto-save OPFS snapshot (persiste aunque se limpie la cache)
      $('progressBar').classList.remove('indeterminate');
      const s4 = await loadStorage();
      if (s4 && s4.isOPFSAvailable()) {
        $('progressText').textContent = 'Guardando snapshot de respaldo…';
        ilog('Guardando snapshot OPFS…');
        const allContacts = [];
        await getAllContactsDynamic(chunk => allContacts.push(...chunk));
        const snap = await s4.saveOPFSSnapshot(allContacts, kpis);
        if (snap.ok) ilog(`Snapshot guardado: ${fmtNum(snap.total)} contactos`);
      }

      // 5. Refrescar UI
      await refreshKPIs();
      await loadPage(1);
      await updateStorageInfo();
      showProg(false);

      toast(`✓ Import completo: ${fmtNum(kpis.total)} contactos en total`, 'success', 5000);
      ilog(`Listo. ${fmtNum(kpis.total)} contactos cargados.`);

      if (worker._res?.[fileIndex]) { worker._res[fileIndex].resolve(); delete worker._res[fileIndex]; }
    });
  }
  if (m.type === 'error') {
    logErr('Parser: ' + m.message);
    toast('Error al parsear: ' + m.message, 'error');
    if (worker._res?.[m.fileIndex]) { worker._res[m.fileIndex].reject(new Error(m.message)); }
  }
}

/* ── Batch queue ─────────────────────────────────────────────── */
async function drainQueue() {
  if (insertingBatch || !importQueue.length) return;
  insertingBatch = true;
  while (importQueue.length) {
    const batch = importQueue.shift();
    let ok = false, attempt = 0;
    while (!ok && attempt < CFG.WORKER_RETRIES) {
      try { await addContactsBatch(batch, CFG.FAST_IMPORT); ok = true; }
      catch(e) {
        attempt++;
        logWarn(`Batch retry ${attempt}: ${e.message}`);
        await sleep(CFG.RETRY_BACKOFF * Math.pow(2, attempt - 1));
      }
    }
    await sleep(CFG.BATCH_DELAY_MS);
  }
  insertingBatch = false;
}

function waitEmpty(onMsg) {
  let batchN = 0;
  return new Promise(res => {
    const t = setInterval(() => {
      if (importQueue.length > 0 || insertingBatch) {
        batchN++;
        if (onMsg && batchN % 5 === 0) {
          onMsg(`Guardando en base de datos… ${fmtNum(importQueue.length)} lotes pendientes`);
        }
      } else {
        clearInterval(t);
        res();
      }
    }, 200);
  });
}

/* ── Fallback import (sin Worker) ────────────────────────────── */
function fallbackImport(file, resolve, reject) {
  logWarn('Import sin Worker (≤50k recomendado)');
  Papa.parse(file, {
    header: true, skipEmptyLines: true, chunkSize: 100 * 1024,
    chunk(r) {
      const rows = r.data.map(row => {
        const rut = normalizeRUT(row.id_card_number || row.document || '');
        if (!rut) return null;
        const id = row.id; delete row.id;
        return { ...row, sourceId:id, document:rut, status:'pending', purchaseCount:0, importedAt:Date.now(), updatedAt:Date.now() };
      }).filter(Boolean);
      if (rows.length) { importQueue.push(rows); if (!insertingBatch) drainQueue(); }
    },
    complete: () => waitEmpty(msg => { $('progressText').textContent = msg; }).then(async () => {
      $('progressText').textContent = 'Recalculando estadísticas…';
      const kpis = await recalculateKPIs(); await refreshKPIs(); await loadPage(1);
      showProg(false); toast(`✓ ${fmtNum(kpis.total)} contactos cargados`, 'success', 5000); resolve();
    }),
    error: reject,
  });
}

/* ── KPIs ────────────────────────────────────────────────────── */
async function refreshKPIs() {
  try {
    const k = await getKPIs();
    $('k_total').textContent      = fmtNum(k.total      || 0);
    $('k_pending').textContent    = fmtNum(k.pending    || 0);
    $('k_contacted').textContent  = fmtNum(k.contacted  || 0);
    $('k_responded').textContent  = fmtNum(k.responded  || 0);
    $('k_purchased').textContent  = fmtNum(k.purchased  || 0);
    $('k_noresponse').textContent = fmtNum(k.noresponse || 0);
    $('k_optout').textContent     = fmtNum(k.optout     || 0);
  } catch(e) {}
}

/* ── Tabla + Paginación ──────────────────────────────────────── */
async function loadPage(p) {
  if (p < 1) return;
  const limit  = CFG.PAGE_SIZE + 1;
  const offset = (p - 1) * CFG.PAGE_SIZE;
  try {
    const rows = await queryFiltered(filter, limit, offset);
    const hasNext = rows.length > CFG.PAGE_SIZE;
    pageRows = hasNext ? rows.slice(0, CFG.PAGE_SIZE) : rows;
    page = p;

    renderTable(pageRows);

    const from = offset + 1, to = offset + pageRows.length;
    $('resultCount').textContent = pageRows.length
      ? `Mostrando ${fmtNum(from)}–${fmtNum(to)}${hasNext ? '+' : ''}`
      : 'Sin resultados';

    $('pageNum').textContent    = `Pág. ${p}`;
    $('btnPrevPage').disabled   = p <= 1;
    $('btnNextPage').disabled   = !hasNext;
  } catch(e) { logErr('loadPage: ' + e.message); }
}

function renderTable(rows) {
  const tbody = $('tableBody');
  tbody.innerHTML = '';

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:80px 0;color:var(--text3)">
      ${filter.q ? `Sin resultados para "${esc(filter.q)}"` : 'Sin resultados'}
    </td></tr>`;
    return;
  }

  const f = document.createDocumentFragment();
  rows.forEach((row, i) => {
    const st = STS[row.status] || STS.pending;
    const isSel = selectedIds.has(row.id);
    const isActive = row.id === activeRowId;
    const ptag = row.purchaseCount ? `<span class="ptag">×${row.purchaseCount}</span>` : '';

    const tr = document.createElement('tr');
    if (isSel)    tr.classList.add('sel');
    if (isActive) tr.classList.add('active');
    tr.dataset.id = row.id;

    tr.innerHTML = `
      <td class="td-num">${(page-1)*CFG.PAGE_SIZE + i + 1}</td>
      <td class="td-name" title="${esc(row.name||'')}" style="overflow:hidden;text-overflow:ellipsis">${esc(row.name||'—')}</td>
      <td class="td-mono">${esc(row.phone||'—')}</td>
      <td class="td-rut">${esc(formatRUT(row.document))}</td>
      <td><span class="badge ${st.cls}"><i></i>${st.label}</span>${ptag}</td>
      <td><div style="display:flex;gap:4px">
        <button class="btn-wa"  data-action="wa">WA</button>
        <button class="btn-sms" data-action="sms">SMS</button>
      </div></td>`;

    tr.addEventListener('click', ev => {
      if (ev.target.closest('[data-action]')) return;
      if (ev.ctrlKey || ev.metaKey) {
        selectedIds[selectedIds.has(row.id) ? 'delete' : 'add'](row.id);
        tr.classList.toggle('sel', selectedIds.has(row.id));
        updateSel(); return;
      }
      tbody.querySelectorAll('tr.active').forEach(r => r.classList.remove('active'));
      tr.classList.add('active');
      activeRowId = row.id;
      openDrawer(row);
    });

    tr.querySelectorAll('[data-action]').forEach(btn =>
      btn.addEventListener('click', ev => { ev.stopPropagation(); quickAction(btn.dataset.action, row); })
    );

    f.appendChild(tr);
  });
  tbody.appendChild(f);
}

function updateSel() { $('selCount').textContent = fmtNum(selectedIds.size) + ' sel.'; }

/* ── Drawer ──────────────────────────────────────────────────── */
function openDrawer(row) { $('drawer').classList.add('open'); renderDrawer(row); }
function closeDrawer()   { $('drawer').classList.remove('open'); activeRowId = null; }

async function renderDrawer(row) {
  const fresh   = await getContactById(row.id) || row;
  const history = await getHistoryForContact(fresh.id);

  $('drawerRUT').textContent = formatRUT(fresh.document) || '—';

  const histHTML = history.length
    ? [...history].reverse().slice(0, 20).map(h => `
        <div class="h-item">
          <span class="h-ts">${fmtTs(h.timestamp)}</span>
          <span class="h-action">${esc(h.action)}</span>
        </div>`).join('')
    : '<p style="color:var(--text3);font-size:11px">Sin historial</p>';

  const sBtns = Object.entries(STS).map(([key, s]) =>
    `<button class="s-btn ${fresh.status===key ? 'on-'+key : ''}" data-status="${key}" data-id="${fresh.id}">${s.label}</button>`
  ).join('');

  $('drawerBody').innerHTML = `
    <div class="df"><div class="df-label">Nombre</div><div class="df-value">${esc(fresh.name||'—')}</div></div>
    <div class="df"><div class="df-label">Teléfono</div><div class="df-value m">${esc(fresh.phone||'—')}</div></div>
    <div class="df"><div class="df-label">Email</div><div class="df-value" style="font-size:12px">${esc(fresh.email||'—')}</div></div>
    <div class="df"><div class="df-label">Importado</div><div class="df-value m" style="font-size:11px;color:var(--text3)">${fmtTs(fresh.importedAt)}</div></div>

    <div class="sec">Estado</div>
    <div class="s-grid">${sBtns}</div>

    <div class="sec">Compras</div>
    <div class="buy-row">
      <button id="buyMinus" class="buy-btn">−</button>
      <div style="flex:1;text-align:center">
        <div id="buyCount" class="buy-num">${fresh.purchaseCount||0}</div>
        <div class="buy-label">compra(s)</div>
      </div>
      <button id="buyPlus" class="buy-btn">+</button>
    </div>

    <div class="sec">Historial</div>
    <div style="overflow-y:auto;max-height:140px">${histHTML}</div>`;

  // Status buttons
  $('drawerBody').querySelectorAll('.s-btn').forEach(btn => {
    btn.onclick = async () => {
      const updated = await updateContactStatus(btn.dataset.id, btn.dataset.status);
      await refreshKPIs();
      toast(`→ ${STS[btn.dataset.status]?.label}`, 'success');
      const idx = pageRows.findIndex(r => r.id === fresh.id);
      if (idx >= 0) { pageRows[idx] = updated; renderTable(pageRows); }
      renderDrawer(updated);
    };
  });

  // Buy counter
  const buy = async delta => {
    const updated = await incrementPurchaseCount(fresh.id, delta);
    if (!updated) return;
    $('buyCount').textContent = updated.purchaseCount || 0;
    const idx = pageRows.findIndex(r => r.id === fresh.id);
    if (idx >= 0) { pageRows[idx] = updated; renderTable(pageRows); }
    toast(`Compras: ${updated.purchaseCount}`, 'success');
  };
  $('buyPlus').onclick  = () => buy(+1);
  $('buyMinus').onclick = () => buy(-1);
}

/* ── Quick actions (botones WA/SMS en fila) ──────────────────── */
function quickAction(action, row) {
  const tpl = templates.find(t => t.name === $('templateSelect').value);
  const msg = tpl ? renderTemplate(tpl.body, row) : `Hola ${row.name||''}`;
  const url = action === 'wa' ? buildWALink(row.phone, msg) : buildSMSLink(row.phone, msg);
  if (url) window.open(url, '_blank');
  updateContactStatus(row.id, 'contacted');
  addHistory(row.id, action, { template: tpl?.name });
}

/* ── Preview de enlaces ──────────────────────────────────────── */
function doPreviewLinks() {
  const rows = pageRows.filter(r => selectedIds.has(r.id));
  if (!rows.length) { toast('Selecciona contactos con Ctrl+click', 'warn'); return; }
  const tpl = templates.find(t => t.name === $('templateSelect').value);
  $('linksPreview').innerHTML = rows.slice(0,50).map(row => {
    const msg = tpl ? renderTemplate(tpl.body, row) : `Hola ${row.name}`;
    return `<div style="padding:8px;background:var(--s2);border-radius:6px;border:1px solid var(--border)">
      <div style="font-weight:500">${esc(row.name)}</div>
      <div style="font-family:var(--mono);font-size:11px;color:var(--text3)">${esc(row.phone)}</div>
      <div style="margin-top:6px;display:flex;gap:8px">
        <a href="${buildWALink(row.phone,msg)}" target="_blank" class="btn-wa" style="text-decoration:none;display:inline-flex;align-items:center">WhatsApp</a>
        <a href="${buildSMSLink(row.phone,msg)}" target="_blank" class="btn-sms" style="text-decoration:none;display:inline-flex;align-items:center">SMS</a>
      </div>
    </div>`;
  }).join('') + (rows.length > 50 ? `<p style="color:var(--text3);font-size:11px;text-align:center">… y ${rows.length-50} más</p>` : '');
  $('linksModal').classList.remove('hidden');
}

/* ── Goteo ───────────────────────────────────────────────────── */
async function doStartDrip() {
  const rows = pageRows.filter(r => selectedIds.has(r.id));
  if (!rows.length) { toast('Selecciona contactos con Ctrl+click', 'warn'); return; }
  if (dripActive)   { toast('Goteo en curso', 'warn'); return; }
  if (!confirm(`¿Iniciar goteo con ${rows.length} contactos en bloques de ${CFG.DRIP_BLOCK}?`)) return;
  dripQueue = [...rows]; dripActive = true;
  await runDripBlock();
}

async function runDripBlock() {
  if (!dripActive || !dripQueue.length) { dripActive = false; toast('Goteo finalizado', 'success'); return; }
  const block = dripQueue.splice(0, CFG.DRIP_BLOCK);
  const tpl = templates.find(t => t.name === $('templateSelect').value);
  ilog(`Goteo: ${block.length} contactos`);
  for (const row of block) {
    const optout = await isOptOut(row.phone);
    if (!optout) {
      const msg = tpl ? renderTemplate(tpl.body, row) : `Hola ${row.name}`;
      window.open(buildWALink(row.phone, msg), '_blank');
      await updateContactStatus(row.id, 'contacted');
      await addHistory(row.id, 'drip_sent', { template: tpl?.name });
    }
    await sleep(300);
  }
  await loadPage(page);
  if (dripQueue.length && confirm(`Bloque enviado. Quedan ${dripQueue.length}. ¿Continuar?`)) await runDripBlock();
  else dripActive = false;
}

/* ── Export ──────────────────────────────────────────────────── */
async function doExport() {
  toast('Generando export…', 'info');
  const chunks = [];
  try {
    await exportFilteredStream(filter, csv => chunks.push(csv), 5000);
    if (!chunks.length) { toast('Sin datos para exportar', 'warn'); return; }
    downloadBlobStream('crm_' + Date.now() + '.csv', chunks);
    toast('Export descargado', 'success');
  } catch(e) { toast('Error en export: ' + e.message, 'error'); }
}

/* ── Plantillas ──────────────────────────────────────────────── */
async function refreshTemplates() {
  templates = await listTemplates();
  const sel = $('templateSelect');
  sel.innerHTML = (templates.length
    ? templates.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`)
    : ['<option value="">Sin plantillas</option>']).join('');
}

async function doSaveTemplate() {
  const name = $('tplName').value.trim(), body = $('tplBody').value.trim();
  if (!name || !body) { toast('Nombre y mensaje requeridos', 'warn'); return; }
  await saveTemplate(name, body);
  await refreshTemplates();
  toast('Plantilla guardada', 'success');
}

/* ── Dedupe ──────────────────────────────────────────────────── */
async function doDedupe() {
  if (!confirm('¿Ejecutar dedupe por RUT? Elimina registros duplicados.')) return;
  toast('Dedupe en progreso…', 'info');
  ilog('Iniciando dedupe…');
  try {
    const deleted = await dedupePassByPhone((d, s, done) => { if (!done) ilog(`Dedupe: ${fmtNum(s)} escaneados`); });
    const kpis = await recalculateKPIs();
    await refreshKPIs();
    await loadPage(1);
    toast(`Dedupe: ${fmtNum(deleted)} eliminados. Total: ${fmtNum(kpis.total)}`, 'success');
    ilog(`Dedupe finalizado: ${fmtNum(deleted)} eliminados`);
  } catch(e) { toast('Error dedupe: ' + e.message, 'error'); }
}

/* ── Clear ───────────────────────────────────────────────────── */
async function doClear() {
  if (!confirm('¿Eliminar TODOS los datos? No se puede deshacer.\n\nTambien se eliminara el snapshot local.')) return;
  await clearAllData(); await resetKPIs();
  const s = await loadStorage();
  if (s && s.isOPFSAvailable()) await s.deleteOPFSSnapshot();
  await refreshKPIs(); await loadPage(1);
  await updateStorageInfo();
  closeDrawer();
  toast('Base de datos limpiada', 'success');
}

/* ── Sintético ───────────────────────────────────────────────── */
async function doSynthetic() {
  const n = parseInt(prompt('¿Cuántas filas generar?', '10000'));
  if (!n || n < 1) return;
  toast(`Generando ${fmtNum(n)} filas…`, 'info');
  showProg(true);
  const file = new File([generateSyntheticCSV(n)], 'synthetic.csv', { type:'text/csv' });
  await importFile(file, 0);
}

/* ── Progreso ────────────────────────────────────────────────── */
function showProg(v) { $('progressSection').style.display = v ? 'block' : 'none'; }
function updateProg({ processed, total, rowsPerSec, filtered, duplicates }) {
  const pct = total > 0 ? Math.min(100, Math.round(processed/total*100)) : 0;
  $('progressBar').style.width = pct + '%';
  $('progressPct').textContent = pct + '%';
  $('progressText').textContent =
    `${fmtNum(processed)} / ~${fmtNum(total)} · ${fmtNum(rowsPerSec)} f/s` +
    (filtered  ? ` · ${fmtNum(filtered)} excluidos` : '') +
    (duplicates ? ` · ${fmtNum(duplicates)} dup.` : '');
}

/* ── Log (inline en bottom bar) ─────────────────────────────── */
function ilog(msg)    { $('inlineLog').textContent = msg; console.info('[CRM]', msg); }
function logWarn(msg) { $('inlineLog').textContent = '⚠ ' + msg; console.warn('[CRM]', msg); }
function logErr(msg)  { $('inlineLog').textContent = '✕ ' + msg; console.error('[CRM]', msg); }

/* ── Toast ───────────────────────────────────────────────────── */
function toast(msg, type = 'info', ms = 3000) {
  const container = $('toasts');
  if (!container) return;
  const d = document.createElement('div');
  d.className = `toast t-${type}`;
  d.textContent = msg;
  container.appendChild(d);
  setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .3s'; setTimeout(() => d.remove(), 300); }, ms);
}

/* ── OPFS / Backup functions ─────────────────────────────────── */

async function promptOPFSRestore(meta) {
  const d = new Date(meta.savedAt).toLocaleString('es-CL');
  const ok = confirm(
    `Se encontro un snapshot guardado:\n` +
    `  ${fmtNum(meta.total)} contactos\n` +
    `  Guardado: ${d}\n\n` +
    `¿Restaurar automaticamente?`
  );
  if (!ok) return;
  const s = await loadStorage();
  if (!s) return;
  showProg(true);
  $('progressText').textContent = 'Restaurando snapshot…';
  ilog('Restaurando desde OPFS…');
  try {
    const total = await s.restoreOPFSSnapshot(
      async (batch) => { await restoreBatchDynamic(batch); },
      (l, t) => {
        const pct = Math.round(l/t*100);
        $('progressBar').style.width = pct + '%';
        $('progressPct').textContent = pct + '%';
        $('progressText').textContent = `Restaurando: ${fmtNum(l)} / ${fmtNum(t)}`;
      }
    );
    await recalculateKPIs(); await refreshKPIs(); await loadPage(1);
    showProg(false);
    toast(`✓ Restaurado: ${fmtNum(total)} contactos`, 'success', 5000);
    ilog(`Restauracion completa: ${fmtNum(total)} contactos`);
  } catch(e) {
    showProg(false);
    logErr('Error restaurando: ' + e.message);
    toast('Error al restaurar snapshot', 'error');
  }
}

async function doSaveSnapshot() {
  const s = await loadStorage();
  if (!s || !s.isOPFSAvailable()) { toast('OPFS no disponible en este navegador', 'warn'); return; }
  toast('Guardando snapshot…', 'info');
  ilog('Guardando snapshot OPFS…');
  try {
    const kpis = await getKPIs();
    const allContacts = [];
    await getAllContactsDynamic(chunk => allContacts.push(...chunk));
    const snap = await s.saveOPFSSnapshot(allContacts, kpis);
    if (snap.ok) {
      toast(`✓ Snapshot: ${fmtNum(snap.total)} contactos`, 'success');
      ilog(`Snapshot guardado: ${fmtNum(snap.total)} contactos`);
      await updateStorageInfo();
    } else {
      toast('Error: ' + snap.reason, 'error');
    }
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

async function doExportBackup() {
  const s = await loadStorage();
  if (!s) { toast('storage.js no disponible', 'error'); return; }
  toast('Preparando backup…', 'info');
  try {
    const kpis = await getKPIs();
    const allContacts = [];
    await getAllContactsDynamic(chunk => allContacts.push(...chunk));
    await s.exportCRMBackup(allContacts, kpis);
    toast(`✓ Backup: ${fmtNum(allContacts.length)} contactos`, 'success');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

async function doImportBackup(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';
  if (!file.name.endsWith('.crm') && !file.name.endsWith('.json')) {
    toast('Selecciona un archivo .crm', 'warn'); return;
  }
  if (!confirm(`¿Restaurar backup "${file.name}"?\nEsto agrega los contactos a los existentes.`)) return;
  const s = await loadStorage();
  if (!s) { toast('storage.js no disponible', 'error'); return; }
  showProg(true);
  $('progressText').textContent = 'Importando backup…';
  ilog(`Importando backup: ${file.name}`);
  try {
    const result = await s.importCRMBackup(
      file,
      async (batch) => { await addContactsBatch(batch, true); },
      (loaded, total) => {
        const pct = Math.round(loaded/total*100);
        $('progressBar').style.width = pct + '%';
        $('progressPct').textContent = pct + '%';
        $('progressText').textContent = `Importando: ${fmtNum(loaded)} / ${fmtNum(total)}`;
      }
    );
    await recalculateKPIs(); await refreshKPIs(); await loadPage(1);
    showProg(false);
    toast(`✓ Backup restaurado: ${fmtNum(result.total)} contactos`, 'success', 5000);
    ilog(`Backup importado: ${fmtNum(result.total)} contactos`);
  } catch(e) {
    showProg(false);
    toast('Error importando backup: ' + e.message, 'error');
    logErr('doImportBackup: ' + e.message);
  }
}

async function updateStorageInfo() {
  const el = $('storageInfo');
  if (!el) return;
  try {
    const s = await loadStorage();
    if (!s) return;
    const info = await s.getStorageInfo();
    const meta = s.isOPFSAvailable() ? await s.readOPFSMeta() : null;
    if (info) {
      el.textContent = `DB: ${info.usageMB}MB / ${info.quotaGB}GB` +
        (meta ? ` · snapshot: ${fmtNum(meta.total)}` : ' · sin snapshot');
    }
  } catch {}
}

// Override showToast del utils.js para usar el toast local
window._crmToast = toast;

/* ── Helpers ─────────────────────────────────────────────────── */
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtSize(b) { return b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB'; }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

document.addEventListener('DOMContentLoaded', boot);