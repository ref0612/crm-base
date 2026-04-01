/**
 * storage.js - Persistent storage using OPFS (Origin Private File System)
 *
 * Why OPFS instead of just IndexedDB:
 *   - IndexedDB IS cleared when the user clicks "Clear browsing data > Site data"
 *   - OPFS files live in a separate browser-managed directory that is:
 *       * NOT cleared by "Clear cache" or "Clear cookies"
 *       * Only cleared by "Clear site data" (which also nukes IndexedDB anyway)
 *       * More durable than cache storage
 *   - OPFS allows reading/writing actual files, enabling:
 *       * Backup/restore of the full database as a single file
 *       * Snapshots that can be moved between machines
 *       * Recovery after IndexedDB corruption
 *
 * Architecture:
 *   - Primary storage: IndexedDB (fast queries, indexes)
 *   - Backup storage: OPFS JSON snapshots (survives partial cache clears)
 *   - On startup: if IndexedDB is empty but OPFS snapshot exists -> restore
 *   - On import complete: auto-save snapshot to OPFS
 *   - Manual: user can export a .crm backup file and re-import it
 *
 * OPFS support: Chrome 102+, Edge 102+, Firefox 111+, Safari 15.2+
 */

const SNAPSHOT_FILENAME = 'crm_snapshot.json';
const SNAPSHOT_META_FILENAME = 'crm_snapshot_meta.json';

/** Check if OPFS is available in this browser */
export function isOPFSAvailable() {
  return typeof navigator !== 'undefined'
    && 'storage' in navigator
    && typeof navigator.storage.getDirectory === 'function';
}

/** Get the OPFS root directory handle */
async function getOPFSRoot() {
  return await navigator.storage.getDirectory();
}

/**
 * Save a snapshot of all contacts to OPFS.
 * Called automatically after import completes.
 * @param {Array} contacts - Array of contact objects
 * @param {Object} kpis - Current KPI counts
 */
export async function saveOPFSSnapshot(contacts, kpis) {
  if (!isOPFSAvailable()) return { ok: false, reason: 'OPFS not supported' };

  try {
    const root = await getOPFSRoot();

    // Write contacts in chunks to avoid memory issues with 1M records
    const CHUNK = 50000;
    const chunks = [];
    for (let i = 0; i < contacts.length; i += CHUNK) {
      chunks.push(contacts.slice(i, i + CHUNK));
    }

    // Write main snapshot file
    const fileHandle = await root.getFileHandle(SNAPSHOT_FILENAME, { create: true });
    const writable   = await fileHandle.createWritable();

    await writable.write('{"version":2,"contacts":[');
    let first = true;
    for (const chunk of chunks) {
      const str = chunk.map(c => JSON.stringify(c)).join(',');
      await writable.write((first ? '' : ',') + str);
      first = false;
    }
    await writable.write(']}');
    await writable.close();

    // Write meta file (fast to read on startup)
    const metaHandle   = await root.getFileHandle(SNAPSHOT_META_FILENAME, { create: true });
    const metaWritable = await metaHandle.createWritable();
    await metaWritable.write(JSON.stringify({
      version:   2,
      savedAt:   Date.now(),
      total:     contacts.length,
      kpis:      kpis,
      filename:  SNAPSHOT_FILENAME,
    }));
    await metaWritable.close();

    return { ok: true, total: contacts.length };
  } catch (err) {
    console.error('[OPFS] saveSnapshot error:', err);
    return { ok: false, reason: err.message };
  }
}

/**
 * Read OPFS snapshot metadata (fast - small file).
 * Returns null if no snapshot exists.
 */
export async function readOPFSMeta() {
  if (!isOPFSAvailable()) return null;
  try {
    const root       = await getOPFSRoot();
    const metaHandle = await root.getFileHandle(SNAPSHOT_META_FILENAME);
    const file       = await metaHandle.getFile();
    const text       = await file.text();
    return JSON.parse(text);
  } catch {
    return null; // file doesn't exist yet
  }
}

/**
 * Restore contacts from OPFS snapshot.
 * Calls onBatch(rows[]) for each chunk so the caller can insert into IndexedDB.
 * Calls onProgress(loaded, total) periodically.
 */
export async function restoreOPFSSnapshot(onBatch, onProgress) {
  if (!isOPFSAvailable()) throw new Error('OPFS no soportado en este navegador');

  const root       = await getOPFSRoot();
  const fileHandle = await root.getFileHandle(SNAPSHOT_FILENAME);
  const file       = await fileHandle.getFile();
  const text       = await file.text();

  const data = JSON.parse(text);
  if (!data.contacts || !Array.isArray(data.contacts)) {
    throw new Error('Snapshot corrupto o formato invalido');
  }

  const total = data.contacts.length;
  const CHUNK = 1000;
  let loaded = 0;

  for (let i = 0; i < total; i += CHUNK) {
    const batch = data.contacts.slice(i, i + CHUNK);
    await onBatch(batch);
    loaded += batch.length;
    if (onProgress) onProgress(loaded, total);
    // Yield to keep UI responsive during restore
    await new Promise(r => setTimeout(r, 0));
  }

  return total;
}

/**
 * Delete the OPFS snapshot (e.g. after "Limpiar todos los datos").
 */
export async function deleteOPFSSnapshot() {
  if (!isOPFSAvailable()) return;
  try {
    const root = await getOPFSRoot();
    await root.removeEntry(SNAPSHOT_FILENAME).catch(() => {});
    await root.removeEntry(SNAPSHOT_META_FILENAME).catch(() => {});
  } catch {}
}

/**
 * Export snapshot as a downloadable .crm file (JSON).
 * The user can save this file and re-import it later from any browser.
 */
export async function exportCRMBackup(contacts, kpis) {
  const payload = JSON.stringify({ version: 2, exportedAt: Date.now(), kpis, contacts });
  const blob    = new Blob([payload], { type: 'application/json' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href        = url;
  a.download    = 'crm_backup_' + new Date().toISOString().slice(0,10) + '.crm';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Import a .crm backup file (from exportCRMBackup).
 * Calls onBatch(rows[]) for each chunk.
 */
export async function importCRMBackup(file, onBatch, onProgress) {
  const text = await file.text();
  const data = JSON.parse(text);

  if (!data.contacts || !Array.isArray(data.contacts)) {
    throw new Error('Archivo .crm invalido o corrupto');
  }

  const total = data.contacts.length;
  const CHUNK = 1000;
  let loaded  = 0;

  for (let i = 0; i < total; i += CHUNK) {
    const batch = data.contacts.slice(i, i + CHUNK);
    // Strip the IDB autoIncrement id so it gets re-assigned on insert
    batch.forEach(c => { delete c.id; });
    await onBatch(batch);
    loaded += batch.length;
    if (onProgress) onProgress(loaded, total);
    await new Promise(r => setTimeout(r, 0));
  }

  return { total, kpis: data.kpis };
}

/**
 * Get storage quota information.
 * Returns { usage, quota, usageMB, quotaGB, percentUsed }
 */
export async function getStorageInfo() {
  if (!navigator.storage?.estimate) return null;
  try {
    const est = await navigator.storage.estimate();
    return {
      usage:       est.usage     || 0,
      quota:       est.quota     || 0,
      usageMB:     Math.round((est.usage || 0) / 1024 / 1024),
      quotaGB:     Math.round((est.quota || 0) / 1024 / 1024 / 1024 * 10) / 10,
      percentUsed: est.quota ? Math.round((est.usage / est.quota) * 100) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Request persistent storage permission (prevents automatic eviction by browser).
 * Returns true if granted.
 */
export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    const granted = await navigator.storage.persist();
    return granted;
  } catch {
    return false;
  }
}
