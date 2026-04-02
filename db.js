/**
 * db.js — Capa de persistencia con IndexedDB
 *
 * Stores:
 *   contacts  — keyPath:'id' autoIncrement; índices: phone, document, status, updatedAt
 *   optouts   — keyPath:'phone'
 *   history   — keyPath:'id' autoIncrement; índice: contactId
 *   templates — keyPath:'name'
 *   meta      — keyPath:'key'  → contadores KPI persistentes entre reinicios
 *
 * Diseño para 1 M registros:
 *   • addContactsBatch usa una sola transacción readwrite por lote (configurable 500–2000 filas).
 *   • Contadores KPI se actualizan de forma incremental en cada batch (sin count() masivo).
 *   • dedupePass hace un cursor scan y elimina teléfonos duplicados en background.
 *   • queryFiltered usa cursor con early-exit para no cargar 1M en RAM.
 */

const DB_NAME    = 'crm_bigdata_v2';
const DB_VERSION = 2;
let db = null;

/* ─── INIT ──────────────────────────────────────────────────────*/
export async function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const idb = e.target.result;

      // contacts
      if (!idb.objectStoreNames.contains('contacts')) {
        const s = idb.createObjectStore('contacts', { keyPath:'id', autoIncrement:true });
        s.createIndex('phone',     'phone',     { unique:false });
        s.createIndex('document',  'document',  { unique:false });
        s.createIndex('status',    'status',    { unique:false });
        s.createIndex('updatedAt', 'updatedAt', { unique:false });
      }

      // optouts
      if (!idb.objectStoreNames.contains('optouts')) {
        idb.createObjectStore('optouts', { keyPath:'phone' });
      }

      // history
      if (!idb.objectStoreNames.contains('history')) {
        const h = idb.createObjectStore('history', { keyPath:'id', autoIncrement:true });
        h.createIndex('contactId', 'contactId', { unique:false });
      }

      // templates
      if (!idb.objectStoreNames.contains('templates')) {
        idb.createObjectStore('templates', { keyPath:'name' });
      }

      // meta (contadores KPI + configuración)
      if (!idb.objectStoreNames.contains('meta')) {
        idb.createObjectStore('meta', { keyPath:'key' });
      }
    };

    req.onsuccess = (e) => {
      db = e.target.result;

      // Manejar cierre inesperado (Safari/Chrome pueden cerrar la DB)
      db.onversionchange = () => { db.close(); db = null; };

      console.info(`[DB] ${DB_NAME} v${DB_VERSION} lista`);
      resolve(db);
    };

    req.onerror = (e) => {
      console.error('[DB] init error:', e.target.error);
      reject(e.target.error);
    };
  });
}

/* ─── HELPER DE TRANSACCIÓN ─────────────────────────────────────*/
function tx(stores, mode = 'readwrite') {
  if (!db) throw new Error('DB no inicializada — llama initDB() primero');
  return db.transaction(Array.isArray(stores) ? stores : [stores], mode);
}

/* ─── STATUSES VÁLIDOS ──────────────────────────────────────────
 * Fuente única de verdad para statuses en toda la app.
 */
export const STATUSES = ['pending','contacted','responded','purchased','noresponse','optout'];

/* ─── KPIs: RECÁLCULO REAL DESDE IndexedDB ─────────────────────
 * Se hace un cursor scan contando por status + total.
 * Se llama tras import (al completar) y tras dedupe.
 * Durante el import se muestran estimaciones incrementales;
 * al finalizar se recalcula el valor exacto.
 *
 * Para 1M filas el scan tarda ~200–500ms (readonly, sin overhead
 * de escritura). Acceptable para una operación puntual.
 */
export async function recalculateKPIs() {
  return new Promise((resolve, reject) => {
    try {
      const counts = { total:0, pending:0, contacted:0, responded:0,
                       purchased:0, noresponse:0, optout:0 };
      const t = tx('contacts', 'readonly');
      const req = t.objectStore('contacts').openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) {
          // Persistir en meta store para arranques rápidos
          _saveKPIs(counts).then(() => resolve(counts)).catch(() => resolve(counts));
          return;
        }
        counts.total++;
        const s = cursor.value.status || 'pending';
        if (counts[s] !== undefined) counts[s]++;
        cursor.continue();
      };
      req.onerror = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

function _saveKPIs(counts) {
  return new Promise((resolve, reject) => {
    try {
      const t = tx('meta');
      const s = t.objectStore('meta');
      Object.entries(counts).forEach(([k,v]) => s.put({ key:'kpi_'+k, value:v }));
      t.oncomplete = () => resolve();
      t.onerror = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

/** Lee los KPIs guardados (rápido, sin scan) */
export async function getKPIs() {
  return new Promise((resolve, reject) => {
    try {
      const keys = ['total','pending','contacted','responded','purchased','noresponse','optout'];
      const t = tx('meta', 'readonly');
      const s = t.objectStore('meta');
      const results = {};
      let pending = keys.length;
      keys.forEach(k => {
        const r = s.get('kpi_' + k);
        r.onsuccess = () => {
          results[k] = r.result ? r.result.value : 0;
          if (--pending === 0) resolve(results);
        };
        r.onerror = () => { results[k] = 0; if (--pending === 0) resolve(results); };
      });
    } catch(err) { reject(err); }
  });
}

/** Incremento rápido durante import (estimación; recalcular al final) */
export async function incrementKPI(key, delta = 1) {
  return new Promise((resolve, reject) => {
    try {
      const t = tx('meta');
      const s = t.objectStore('meta');
      const metaKey = 'kpi_' + key;
      const r = s.get(metaKey);
      r.onsuccess = () => {
        const cur = r.result ? r.result.value : 0;
        s.put({ key: metaKey, value: Math.max(0, cur + delta) });
        resolve(cur + delta);
      };
      r.onerror = (ev) => reject(ev.target.error);
    } catch(err) { reject(err); }
  });
}

export async function resetKPIs() {
  const zero = { total:0,pending:0,contacted:0,responded:0,purchased:0,noresponse:0,optout:0 };
  return _saveKPIs(zero);
}

/* ─── INSERCIÓN MASIVA POR BATCH ────────────────────────────────
 * Estrategia de dedup en dos capas:
 *   Capa 1 (dentro del batch): Set en memoria para RUT y phone.
 *           Evita insertar dos veces el mismo valor dentro del mismo batch.
 *   Capa 2 (cross-batch): Bloom filter en el Worker (pre-filtro) +
 *           dedupe pass posterior (exacto).
 * fastImport=true → put() (más rápido, dedupe posterior limpia el resto)
 */
export async function addContactsBatch(contacts = [], fastImport = true) {
  if (!contacts.length) return { added:0, skipped:0 };

  return new Promise((resolve, reject) => {
    let added = 0, skipped = 0;

    // Dedup intra-batch por RUT Y por teléfono
    const batchSeenRUT   = new Set();
    const batchSeenPhone = new Set();

    const t = tx(['contacts','optouts'], 'readwrite');
    const store    = t.objectStore('contacts');
    const optStore = t.objectStore('optouts');

    t.oncomplete = () => resolve({ added, skipped });
    t.onerror    = (e) => { console.error('[DB] batch tx error:', e.target.error); reject(e.target.error); };
    t.onabort    = (e) => { console.error('[DB] batch tx aborted:', e.target.error); reject(e.target.error); };

    for (const c of contacts) {
      // Renombrar id del CSV para no conflictuar con autoIncrement
      if (c.id !== undefined) { c.sourceId = c.id; delete c.id; }

      const rut   = c.document || '';
      const phone = c.phone    || '';

      // Dedup intra-batch: saltar si ya vimos este RUT o este teléfono en el lote
      if (rut && batchSeenRUT.has(rut))                               { skipped++; continue; }
      if (phone && phone.replace(/\D/g,'').length >= 7
          && batchSeenPhone.has(phone))                               { skipped++; continue; }

      if (rut)   batchSeenRUT.add(rut);
      if (phone) batchSeenPhone.add(phone);

      // Opt-out check + insert
      if (phone) {
        const oor = optStore.get(phone);
        oor.onsuccess = () => { if (oor.result) c.status = 'optout'; insertOne(c); };
        oor.onerror   = () => insertOne(c);
      } else {
        insertOne(c);
      }
    }

    function insertOne(c) {
      const r = fastImport ? store.put(c) : store.add(c);
      r.onsuccess = () => { added++; };
      r.onerror   = (ev) => {
        ev.preventDefault();
        if (!fastImport) {
          const p = store.put(c);
          p.onsuccess = () => { added++; };
          p.onerror   = (pev) => { pev.preventDefault(); skipped++; };
        } else { skipped++; }
      };
    }
  });
}

/* ─── DEDUPE PASS EN BACKGROUND ─────────────────────────────────
 * Elimina duplicados por RUT (document) Y por teléfono (phone).
 * Lógica: un contacto se elimina si su RUT O su teléfono ya fue visto.
 * Mantiene el primer registro encontrado (id más bajo = más antiguo).
 */
export async function dedupePassByPhone(onProgress) {
  if (!db) throw new Error('DB no inicializada');

  return new Promise((resolve, reject) => {
    const seenRUT   = new Map();
    const seenPhone = new Map();
    const toDelete  = [];
    let scanned = 0;

    const scanTx = db.transaction(['contacts'], 'readonly');
    const store  = scanTx.objectStore('contacts');
    const cur    = store.openCursor();

    cur.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) {
        deleteChunked(toDelete, resolve, reject, onProgress);
        return;
      }

      scanned++;
      const { document: rut, phone, id } = cursor.value;
      let isDup = false;

      // Chequear RUT
      if (rut) {
        if (seenRUT.has(rut)) isDup = true;
        else seenRUT.set(rut, id);
      }

      // Chequear teléfono (solo si tiene 7+ dígitos)
      if (!isDup && phone && phone.replace(/\D/g,'').length >= 7) {
        if (seenPhone.has(phone)) isDup = true;
        else seenPhone.set(phone, id);
      }

      if (isDup) toDelete.push(id);

      if (scanned % 10000 === 0 && onProgress) {
        onProgress(toDelete.length, scanned, false);
      }
      cursor.continue();
    };

    cur.onerror = (e) => reject(e.target.error);
  });
}

function deleteChunked(ids, resolve, reject, onProgress, offset = 0, totalDeleted = 0) {
  if (offset >= ids.length) {
    if (onProgress) onProgress(totalDeleted, 0, true);
    resolve(totalDeleted);
    return;
  }
  const chunk = ids.slice(offset, offset + 500);
  const t = db.transaction(['contacts'], 'readwrite');
  const s = t.objectStore('contacts');
  chunk.forEach(id => s.delete(id));
  t.oncomplete = () => {
    totalDeleted += chunk.length;
    if (onProgress) onProgress(totalDeleted, ids.length, false);
    // Ceder al event loop antes del siguiente chunk
    setTimeout(() => deleteChunked(ids, resolve, reject, onProgress, offset + 500, totalDeleted), 10);
  };
  t.onerror = (e) => reject(e.target.error);
}

/* ─── QUERIES ───────────────────────────────────────────────────*/
export async function findByPhone(phone) {
  return new Promise((resolve, reject) => {
    try {
      const r = tx('contacts','readonly').objectStore('contacts').index('phone').getAll(phone);
      r.onsuccess = () => resolve(r.result || []);
      r.onerror   = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

export async function findByDocument(document) {
  return new Promise((resolve, reject) => {
    try {
      const r = tx('contacts','readonly').objectStore('contacts').index('document').getAll(document);
      r.onsuccess = () => resolve(r.result || []);
      r.onerror   = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

/**
 * queryFiltered — cursor scan con filtro q (name/phone/document).
 * Para 1M registros, sin filtro devuelve hasta `limit` en ~50–200ms.
 * Con filtro de texto la latencia depende del porcentaje de matches.
 * Para búsquedas muy frecuentes recomendamos índice invertido en memoria
 * (ver buildInMemoryIndex en app.js).
 */
export async function queryFiltered(filter = {}, limit = 50, offset = 0) {
  return new Promise((resolve, reject) => {
    try {
      const results = [];
      let skipped = 0;
      const t = tx('contacts', 'readonly');
      const store = t.objectStore('contacts');

      // Normalizar la query para búsqueda robusta
      // Si parece RUT (tiene dígitos + posible guion/puntos), normalizar como RUT
      let qRaw = (filter.q || '').trim();
      let qNorm = qRaw.toLowerCase();
      // Intentar normalizar como RUT si tiene forma de RUT
      let qRUT = null;
      if (qRaw && /[\d]/.test(qRaw)) {
        // Quitar puntos, buscar como substring del RUT normalizado
        qRUT = qRaw.replace(/\./g, '').replace(/\s/g, '').toUpperCase();
      }

      let req;
      // Usar índice de status si solo hay filtro de estado (sin texto)
      if (filter.status && !qRaw) {
        req = store.index('status').openCursor(IDBKeyRange.only(filter.status));
      } else {
        req = store.openCursor();
      }

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return resolve(results);
        const rec = cursor.value;
        let ok = true;

        if (qRaw) {
          const nameMatch  = rec.name     && rec.name.toLowerCase().includes(qNorm);
          const emailMatch = rec.email    && rec.email.toLowerCase().includes(qNorm);
          // Búsqueda por teléfono: solo dígitos
          const phoneMatch = rec.phone    && rec.phone.includes(qRaw.replace(/[^\d+]/g,''));
          // Búsqueda por RUT: comparar contra el RUT normalizado almacenado
          const rutMatch   = rec.document && qRUT && rec.document.replace('-','').includes(qRUT.replace(/[-]/g,''));

          ok = nameMatch || phoneMatch || rutMatch || emailMatch;
        }

        if (filter.status && qRaw) ok = ok && rec.status === filter.status;

        if (ok) {
          if (skipped < offset) skipped++;
          else {
            results.push(rec);
            if (results.length >= limit) return resolve(results);
          }
        }
        cursor.continue();
      };
      req.onerror = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

// Normaliza el id para IDB: convierte "123" → 123 si es numérico.
// Los datasets HTML siempre devuelven strings; IDB autoIncrement usa números.
function normalizeId(id) {
  if (id === undefined || id === null || id === '') return id;
  const n = Number(id);
  return isNaN(n) ? id : n;  // si no es numérico, dejarlo como string
}

export async function getContactById(id) {
  return new Promise((resolve, reject) => {
    try {
      const key = normalizeId(id);
      if (key === undefined || key === null || key === '') {
        return resolve(null);
      }
      const r = tx('contacts','readonly').objectStore('contacts').get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror   = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

export async function updateContactStatus(id, status, note = '') {
  return new Promise((resolve, reject) => {
    try {
      const key = normalizeId(id);
      const t = tx(['contacts','history']);
      const store = t.objectStore('contacts');
      const r = store.get(key);
      r.onsuccess = () => {
        const rec = r.result;
        if (!rec) return resolve(false);
        const oldStatus = rec.status;
        rec.status    = status;
        rec.updatedAt = Date.now();
        if (!rec.notes) rec.notes = [];
        if (note) rec.notes.push({ text:note, ts:Date.now() });

        if (status === 'purchased') {
          rec.purchaseCount = (rec.purchaseCount || 0) + 1;
        }

        store.put(rec).onsuccess = () => {
          t.objectStore('history').add({
            contactId: key, action:'status_update',
            meta:{ from:oldStatus, to:status, note,
                   purchaseCount: rec.purchaseCount },
            timestamp:Date.now()
          });
          Promise.all([
            incrementKPI(oldStatus, -1),
            incrementKPI(status, +1),
          ]).then(() => resolve(rec)).catch(() => resolve(rec));
        };
      };
      r.onerror = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

export async function incrementPurchaseCount(id, delta = 1) {
  return new Promise((resolve, reject) => {
    try {
      const key = normalizeId(id);
      const t = tx(['contacts','history']);
      const store = t.objectStore('contacts');
      const r = store.get(key);
      r.onsuccess = () => {
        const rec = r.result;
        if (!rec) return resolve(null);
        rec.purchaseCount = Math.max(0, (rec.purchaseCount || 0) + delta);
        rec.updatedAt = Date.now();
        store.put(rec).onsuccess = () => {
          t.objectStore('history').add({
            contactId: key, action:'purchase_count',
            meta:{ delta, total: rec.purchaseCount }, timestamp:Date.now()
          });
          resolve(rec);
        };
      };
      r.onerror = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

/* ─── OPT-OUTS ──────────────────────────────────────────────────*/
export async function isOptOut(phone) {
  return new Promise((resolve, reject) => {
    try {
      const r = tx('optouts','readonly').objectStore('optouts').get(phone);
      r.onsuccess = () => resolve(!!r.result);
      r.onerror   = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

export async function addOptOut(phone, meta = {}) {
  return new Promise((resolve, reject) => {
    try {
      const r = tx('optouts').objectStore('optouts').put({ phone, meta, createdAt:Date.now() });
      r.onsuccess = () => { incrementKPI('optout',1); resolve(true); };
      r.onerror   = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

/* ─── HISTORIAL ─────────────────────────────────────────────────*/
export async function addHistory(contactId, action, meta = {}) {
  return new Promise((resolve, reject) => {
    try {
      const r = tx('history').objectStore('history')
                  .add({ contactId, action, meta, timestamp:Date.now() });
      r.onsuccess = () => resolve(true);
      r.onerror   = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

export async function getHistoryForContact(contactId) {
  return new Promise((resolve, reject) => {
    try {
      const r = tx('history','readonly').objectStore('history')
                  .index('contactId').getAll(contactId);
      r.onsuccess = () => resolve(r.result || []);
      r.onerror   = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

/* ─── PLANTILLAS ────────────────────────────────────────────────*/
export async function saveTemplate(name, body) {
  return new Promise((resolve, reject) => {
    try {
      const r = tx('templates').objectStore('templates')
                  .put({ name, body, updatedAt:Date.now() });
      r.onsuccess = () => resolve(true);
      r.onerror   = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

export async function listTemplates() {
  return new Promise((resolve, reject) => {
    try {
      const r = tx('templates','readonly').objectStore('templates').getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror   = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

/* ─── EXPORT STREAMING (chunked) ────────────────────────────────
 * Lee hasta `batchSize` registros con cursor, los acumula como CSV
 * y llama onChunk(csvString) para streaming. Evita cargar 1M en RAM.
 */
export async function exportFilteredStream(filter = {}, onChunk, batchSize = 5000) {
  let headerWritten = false;
  let chunkBuf = [];

  return new Promise((resolve, reject) => {
    try {
      const t = tx('contacts','readonly');
      const store = t.objectStore('contacts');
      const req = store.openCursor();

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) {
          // Vaciar buffer final
          if (chunkBuf.length) {
            onChunk(rowsToCSV(chunkBuf, !headerWritten));
          }
          return resolve();
        }
        const rec = cursor.value;
        let ok = true;
        if (filter.q) {
          const q = filter.q.toLowerCase();
          ok = (rec.name    && rec.name.toLowerCase().includes(q))
            || (rec.phone   && rec.phone.includes(q))
            || (rec.document && rec.document.toLowerCase().includes(q));
        }
        if (filter.status) ok = ok && rec.status === filter.status;

        if (ok) {
          chunkBuf.push(rec);
          if (chunkBuf.length >= batchSize) {
            onChunk(rowsToCSV(chunkBuf, !headerWritten));
            headerWritten = true;
            chunkBuf = [];
          }
        }
        cursor.continue();
      };
      req.onerror = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

function rowsToCSV(rows, includeHeader) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]).filter(k => k !== 'notes');
  const lines = [];
  if (includeHeader) lines.push(keys.map(escapeCSV).join(','));
  for (const r of rows) {
    lines.push(keys.map(k => escapeCSV(r[k] ?? '')).join(','));
  }
  return lines.join('\n') + '\n';
}

function escapeCSV(v) {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/* ─── UTILIDADES ────────────────────────────────────────────────*/
export async function countAll() {
  return new Promise((resolve, reject) => {
    try {
      const r = tx('contacts','readonly').objectStore('contacts').count();
      r.onsuccess = () => resolve(r.result);
      r.onerror   = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

export async function clearAllData() {
  return new Promise((resolve, reject) => {
    try {
      const t = tx(['contacts','optouts','history','meta']);
      ['contacts','optouts','history','meta'].forEach(s => t.objectStore(s).clear());
      t.oncomplete = () => resolve();
      t.onerror    = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

/**
 * getAllContacts - reads ALL contacts for OPFS snapshot.
 * Uses chunked cursor to avoid loading 1M objects at once.
 * Calls onChunk(rows[]) for each CHUNK records.
 */
export async function getAllContacts(onChunk, chunkSize = 5000) {
  return new Promise((resolve, reject) => {
    try {
      let buf = [], total = 0;
      const t   = tx('contacts', 'readonly');
      const req = t.objectStore('contacts').openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) {
          if (buf.length) { onChunk(buf); total += buf.length; }
          resolve(total);
          return;
        }
        buf.push(cursor.value);
        if (buf.length >= chunkSize) {
          onChunk(buf);
          total += buf.length;
          buf = [];
        }
        cursor.continue();
      };
      req.onerror = (e) => reject(e.target.error);
    } catch(err) { reject(err); }
  });
}

/**
 * restoreBatch - insert contacts during OPFS restore.
 * Strips the 'id' field so IDB assigns a new autoIncrement key.
 */
export async function restoreBatch(contacts = []) {
  if (!contacts.length) return 0;
  return new Promise((resolve, reject) => {
    let inserted = 0;
    const t = tx('contacts', 'readwrite');
    const s = t.objectStore('contacts');
    t.oncomplete = () => resolve(inserted);
    t.onerror    = (e) => reject(e.target.error);
    contacts.forEach(c => {
      const copy = Object.assign({}, c);
      delete copy.id; // let IDB assign new key
      const r = s.put(copy);
      r.onsuccess = () => inserted++;
      r.onerror   = (ev) => ev.preventDefault();
    });
  });
}