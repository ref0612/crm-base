// worker-parser.js - Web Worker (classic, NOT module)
// All functions are INLINE here - no import/export allowed in classic workers.
// Communication:
//   IN:  { cmd:'parse', file, batchSize, fileIdx }
//   OUT: { type:'batch'|'progress'|'done'|'error', ... }

importScripts('https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js');

// --- normalizePhone ---
function normalizePhone(raw) {
  if (raw == null) return '';
  var s = String(raw).trim().replace(/^\uFEFF/, '');
  if (/^null$/i.test(s) || s === '' || s === '-' || s === 'N/A') return '';
  var hasPlus = s.startsWith('+');
  var digits = s.replace(/[^\d]/g, '');
  if (digits.length < 7) return '';
  return hasPlus ? ('+' + digits) : digits;
}

// --- normalizeRUT ---
// Input: "18.537.533-1" | "13.186.874-k" | "125761453" | "19740398-5"
// Output: "18537533-1"  | "13186874-K"   | "12576145-3"| "19740398-5"
// Returns null if invalid.
function normalizeRUT(raw) {
  if (raw == null) return null;
  var s = String(raw).trim().toUpperCase();
  if (/^null$/i.test(s) || s === '' || s === '-') return null;
  // Letters other than K mean passport/foreign doc
  if (/[A-JL-Z]/.test(s)) return null;
  var clean = s.replace(/\./g, '').replace(/\s/g, '');
  var body, ver;
  if (clean.indexOf('-') >= 0) {
    var parts = clean.split('-');
    body = parts[0];
    ver  = parts[1] || '';
  } else {
    ver  = clean.slice(-1);
    body = clean.slice(0, -1);
  }
  if (!/^\d+$/.test(body)) return null;
  if (!/^[\dK]$/.test(ver)) return null;
  var num = parseInt(body, 10);
  if (num < 1000000 || num > 99999999) return null;
  return body + '-' + ver;
}

// --- isRUTDocType ---
function isRUTDocType(docTypeStr) {
  if (!docTypeStr) return true; // unknown type - try to parse
  var s = String(docTypeStr).trim().toLowerCase()
    .replace(/[aeiou]/g, function(c) {
      return {'\u00e1':'a','\u00e9':'e','\u00ed':'i','\u00f3':'o','\u00fa':'u'}[c] || c;
    });
  if (/pasaporte|passport|foreig|extranjero/.test(s)) return false;
  return true;
}

// --- header normalization ---
var FIELD_ALIASES = {
  phone_number:'phone', telefono:'phone', tel:'phone',
  mobile:'phone', celular:'phone', cel:'phone', numero:'phone',
  alternate_number:'altPhone',
  id_card_number:'document', rut:'document', dni:'document',
  cedula:'document', documento:'document',
  id_card_type_str:'docType', id_card_type:'docTypeCode',
  nombre:'name', fullname:'name',
  correo:'email', mail:'email'
};

function normalizeKey(k) {
  return String(k)
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\u00e0-\u00e6]/g, 'a')
    .replace(/[\u00e8-\u00eb]/g, 'e')
    .replace(/[\u00ec-\u00ef]/g, 'i')
    .replace(/[\u00f2-\u00f6]/g, 'o')
    .replace(/[\u00f9-\u00fc]/g, 'u')
    .replace(/\u00f1/g, 'n')
    .replace(/[\s\-\.]+/g, '_')
    .replace(/[^\w]/g, '');
}

function canonicalKey(k) {
  var norm = normalizeKey(k);
  return FIELD_ALIASES[norm] || norm;
}

function nullToEmpty(v) {
  if (v == null) return '';
  var s = String(v).trim();
  return /^null$/i.test(s) ? '' : s;
}

// Normaliza nombres: quita @ y espacios extra, capitaliza cada palabra
// "Daniel @Soto Oyarzun" -> "Daniel Soto Oyarzun"
// "patricia@murua"       -> "Patricia Murua"
function normalizeName(raw) {
  if (!raw) return '';
  return raw
    .replace(/@/g, ' ')           // quitar arroba
    .replace(/\s+/g, ' ')         // colapsar espacios
    .trim()
    .split(' ')
    .map(function(w) {
      if (!w) return '';
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

// --- double-quoted row unwrapper (Kupos CSV format) ---
function unwrapRow(fields, headerCount) {
  if (fields.length === 1 && headerCount > 1) {
    var inner = fields[0].replace(/""/g, '\x00').replace(/"/g, '').replace(/\x00/g, '"');
    var result = Papa.parse(inner, { header: false });
    if (result.data[0] && result.data[0].length === headerCount) return result.data[0];
  }
  return null;
}

// --- Bloom filter ---
// m=9.6M bits (~1.14MB), k=7 -> FP~1% for n=1M
// Prefix keys: 'R:' for RUT, 'P:' for phone
var BLOOM_M = 9600000;
var BLOOM_K = 7;
var bloomBuf = new Uint8Array(Math.ceil(BLOOM_M / 8));

function fnv1a(str) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function bloomPositions(key) {
  var h1 = fnv1a(key);
  var h2 = (fnv1a(key.split('').reverse().join(''))) | 1;
  var pos = [];
  for (var i = 0; i < BLOOM_K; i++) {
    pos.push(((h1 + i * h2) >>> 0) % BLOOM_M);
  }
  return pos;
}

function bloomAdd(key) {
  bloomPositions(key).forEach(function(p) { bloomBuf[p >> 3] |= (1 << (p & 7)); });
}

function bloomHas(key) {
  return bloomPositions(key).every(function(p) { return !!(bloomBuf[p >> 3] & (1 << (p & 7))); });
}

// --- Session state ---
var headers = [], headerCount = 0;
var stats = { processed:0, inserted:0, duplicates:0, invalid:0, filtered:0 };
var batchBuffer = [];
var BATCH_SIZE = 800;
var fileIndex = 0, totalRows = 0;
var lastProgressTs = 0, lastProgressRows = 0;

// --- processRow ---
function processRow(rawRow) {
  var fields = Array.isArray(rawRow) ? rawRow : Object.values(rawRow);
  var values = unwrapRow(fields, headerCount) || fields;

  var obj = {};
  headers.forEach(function(h, i) { obj[h] = nullToEmpty(values[i]); });

  // Filter passports
  var docType = obj.docType || '';
  if (!isRUTDocType(docType)) return { row: null, reason: 'filtered' };

  // Normalize RUT (required)
  var rut = normalizeRUT(obj.document || '');
  if (!rut) return { row: null, reason: 'invalid' };

  // Normalize phone (optional)
  var phone = normalizePhone(obj.phone || obj.altPhone || '');

  // Rename CSV id to avoid conflict with IDB autoIncrement
  if (obj.id !== undefined) { obj.sourceId = obj.id; delete obj.id; }

  // Clean up raw fields
  delete obj.altPhone; delete obj.docType; delete obj.docTypeCode;
  delete obj.id_card_number; delete obj.id_card_type; delete obj.id_card_type_str;

  return {
    row: Object.assign(obj, {
      name:  normalizeName(obj.name || ''),   // limpiar @ y capitalizar
      phone: phone,
      document: rut,
      status: 'pending',
      purchaseCount: 0,
      importedAt: Date.now(),
      updatedAt: Date.now()
    }),
    reason: null
  };
}

// --- flush batch ---
function flushBatch(force) {
  if (!batchBuffer.length) return;
  if (batchBuffer.length >= BATCH_SIZE || force) {
    self.postMessage({ type:'batch', rows: batchBuffer, fileIndex: fileIndex, processed: stats.processed, total: totalRows });
    batchBuffer = [];
  }
}

function reportProgress() {
  var now = Date.now();
  var elapsed = Math.max((now - lastProgressTs) / 1000, 0.001);
  var rowsPerSec = Math.round((stats.processed - lastProgressRows) / elapsed);
  lastProgressTs = now;
  lastProgressRows = stats.processed;
  self.postMessage({
    type:'progress', fileIndex: fileIndex,
    processed: stats.processed, total: totalRows,
    rowsPerSec: rowsPerSec,
    duplicates: stats.duplicates,
    invalid: stats.invalid,
    filtered: stats.filtered
  });
}

// --- Entry point ---
self.onmessage = function(e) {
  var data = e.data;
  if (data.cmd !== 'parse') return;

  BATCH_SIZE = data.batchSize || 800;
  fileIndex  = data.fileIdx   || 0;
  stats      = { processed:0, inserted:0, duplicates:0, invalid:0, filtered:0 };
  batchBuffer = [];
  headers = []; headerCount = 0; totalRows = 0;
  lastProgressTs = Date.now(); lastProgressRows = 0;
  // Reset bloom filter for each new file
  bloomBuf.fill(0);
  totalRows = data.file.size ? Math.round(data.file.size / 80) : 0;

  Papa.parse(data.file, {
    header: false,
    skipEmptyLines: true,
    chunkSize: 512 * 1024,

    chunk: function(results) {
      var rows = results.data;

      // First row = headers
      if (headers.length === 0 && rows.length > 0) {
        headers = rows[0].map(canonicalKey);
        headerCount = headers.length;
        rows = rows.slice(1);
      }

      for (var i = 0; i < rows.length; i++) {
        stats.processed++;
        var res = processRow(rows[i]);
        if (!res.row) {
          if (res.reason === 'filtered') stats.filtered++;
          else stats.invalid++;
          continue;
        }

        // Bloom filter: deduplicar SOLO por RUT.
        // No usamos teléfono como clave porque múltiples personas
        // pueden compartir un número (familia, empresa) con RUTs distintos.
        const rutKey = 'R:' + res.row.document;

        if (bloomHas(rutKey)) {
          stats.duplicates++;
        } else {
          bloomAdd(rutKey);
          stats.inserted++;
        }

        batchBuffer.push(res.row);
        flushBatch(false);
      }

      if (Date.now() - lastProgressTs >= 500) reportProgress();
    },

    complete: function() {
      flushBatch(true);
      reportProgress();
      self.postMessage({
        type:'done', fileIndex: fileIndex,
        total: stats.processed,
        inserted: stats.inserted,
        duplicates: stats.duplicates,
        invalid: stats.invalid,
        filtered: stats.filtered
      });
    },

    error: function(err) {
      self.postMessage({ type:'error', message: err.message || String(err), fileIndex: fileIndex });
    }
  });
};// worker-parser.js - Web Worker (classic, NOT module)
// All functions are INLINE here - no import/export allowed in classic workers.
// Communication:
//   IN:  { cmd:'parse', file, batchSize, fileIdx }
//   OUT: { type:'batch'|'progress'|'done'|'error', ... }

importScripts('https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js');

// --- normalizePhone ---
function normalizePhone(raw) {
  if (raw == null) return '';
  var s = String(raw).trim().replace(/^\uFEFF/, '');
  if (/^null$/i.test(s) || s === '' || s === '-' || s === 'N/A') return '';
  var hasPlus = s.startsWith('+');
  var digits = s.replace(/[^\d]/g, '');
  if (digits.length < 7) return '';
  return hasPlus ? ('+' + digits) : digits;
}

// --- normalizeRUT ---
// Input: "18.537.533-1" | "13.186.874-k" | "125761453" | "19740398-5"
// Output: "18537533-1"  | "13186874-K"   | "12576145-3"| "19740398-5"
// Returns null if invalid.
function normalizeRUT(raw) {
  if (raw == null) return null;
  var s = String(raw).trim().toUpperCase();
  if (/^null$/i.test(s) || s === '' || s === '-') return null;
  // Letters other than K mean passport/foreign doc
  if (/[A-JL-Z]/.test(s)) return null;
  var clean = s.replace(/\./g, '').replace(/\s/g, '');
  var body, ver;
  if (clean.indexOf('-') >= 0) {
    var parts = clean.split('-');
    body = parts[0];
    ver  = parts[1] || '';
  } else {
    ver  = clean.slice(-1);
    body = clean.slice(0, -1);
  }
  if (!/^\d+$/.test(body)) return null;
  if (!/^[\dK]$/.test(ver)) return null;
  var num = parseInt(body, 10);
  if (num < 1000000 || num > 99999999) return null;
  return body + '-' + ver;
}

// --- isRUTDocType ---
function isRUTDocType(docTypeStr) {
  if (!docTypeStr) return true; // unknown type - try to parse
  var s = String(docTypeStr).trim().toLowerCase()
    .replace(/[aeiou]/g, function(c) {
      return {'\u00e1':'a','\u00e9':'e','\u00ed':'i','\u00f3':'o','\u00fa':'u'}[c] || c;
    });
  if (/pasaporte|passport|foreig|extranjero/.test(s)) return false;
  return true;
}

// --- header normalization ---
var FIELD_ALIASES = {
  phone_number:'phone', telefono:'phone', tel:'phone',
  mobile:'phone', celular:'phone', cel:'phone', numero:'phone',
  alternate_number:'altPhone',
  id_card_number:'document', rut:'document', dni:'document',
  cedula:'document', documento:'document',
  id_card_type_str:'docType', id_card_type:'docTypeCode',
  nombre:'name', fullname:'name',
  correo:'email', mail:'email'
};

function normalizeKey(k) {
  return String(k)
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\u00e0-\u00e6]/g, 'a')
    .replace(/[\u00e8-\u00eb]/g, 'e')
    .replace(/[\u00ec-\u00ef]/g, 'i')
    .replace(/[\u00f2-\u00f6]/g, 'o')
    .replace(/[\u00f9-\u00fc]/g, 'u')
    .replace(/\u00f1/g, 'n')
    .replace(/[\s\-\.]+/g, '_')
    .replace(/[^\w]/g, '');
}

function canonicalKey(k) {
  var norm = normalizeKey(k);
  return FIELD_ALIASES[norm] || norm;
}

function nullToEmpty(v) {
  if (v == null) return '';
  var s = String(v).trim();
  return /^null$/i.test(s) ? '' : s;
}

// Normaliza nombres: quita @ y espacios extra, capitaliza cada palabra
// "Daniel @Soto Oyarzun" -> "Daniel Soto Oyarzun"
// "patricia@murua"       -> "Patricia Murua"
function normalizeName(raw) {
  if (!raw) return '';
  return raw
    .replace(/@/g, ' ')           // quitar arroba
    .replace(/\s+/g, ' ')         // colapsar espacios
    .trim()
    .split(' ')
    .map(function(w) {
      if (!w) return '';
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

// --- double-quoted row unwrapper (Kupos CSV format) ---
function unwrapRow(fields, headerCount) {
  if (fields.length === 1 && headerCount > 1) {
    var inner = fields[0].replace(/""/g, '\x00').replace(/"/g, '').replace(/\x00/g, '"');
    var result = Papa.parse(inner, { header: false });
    if (result.data[0] && result.data[0].length === headerCount) return result.data[0];
  }
  return null;
}

// --- Bloom filter ---
// m=9.6M bits (~1.14MB), k=7 -> FP~1% for n=1M
// Prefix keys: 'R:' for RUT, 'P:' for phone
var BLOOM_M = 9600000;
var BLOOM_K = 7;
var bloomBuf = new Uint8Array(Math.ceil(BLOOM_M / 8));

function fnv1a(str) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function bloomPositions(key) {
  var h1 = fnv1a(key);
  var h2 = (fnv1a(key.split('').reverse().join(''))) | 1;
  var pos = [];
  for (var i = 0; i < BLOOM_K; i++) {
    pos.push(((h1 + i * h2) >>> 0) % BLOOM_M);
  }
  return pos;
}

function bloomAdd(key) {
  bloomPositions(key).forEach(function(p) { bloomBuf[p >> 3] |= (1 << (p & 7)); });
}

function bloomHas(key) {
  return bloomPositions(key).every(function(p) { return !!(bloomBuf[p >> 3] & (1 << (p & 7))); });
}

// --- Session state ---
var headers = [], headerCount = 0;
var stats = { processed:0, inserted:0, duplicates:0, invalid:0, filtered:0 };
var batchBuffer = [];
var BATCH_SIZE = 800;
var fileIndex = 0, totalRows = 0;
var lastProgressTs = 0, lastProgressRows = 0;

// --- processRow ---
function processRow(rawRow) {
  var fields = Array.isArray(rawRow) ? rawRow : Object.values(rawRow);
  var values = unwrapRow(fields, headerCount) || fields;

  var obj = {};
  headers.forEach(function(h, i) { obj[h] = nullToEmpty(values[i]); });

  // Filter passports
  var docType = obj.docType || '';
  if (!isRUTDocType(docType)) return { row: null, reason: 'filtered' };

  // Normalize RUT (required)
  var rut = normalizeRUT(obj.document || '');
  if (!rut) return { row: null, reason: 'invalid' };

  // Normalize phone (optional)
  var phone = normalizePhone(obj.phone || obj.altPhone || '');

  // Rename CSV id to avoid conflict with IDB autoIncrement
  if (obj.id !== undefined) { obj.sourceId = obj.id; delete obj.id; }

  // Clean up raw fields
  delete obj.altPhone; delete obj.docType; delete obj.docTypeCode;
  delete obj.id_card_number; delete obj.id_card_type; delete obj.id_card_type_str;

  return {
    row: Object.assign(obj, {
      name:  normalizeName(obj.name || ''),   // limpiar @ y capitalizar
      phone: phone,
      document: rut,
      status: 'pending',
      purchaseCount: 0,
      importedAt: Date.now(),
      updatedAt: Date.now()
    }),
    reason: null
  };
}

// --- flush batch ---
function flushBatch(force) {
  if (!batchBuffer.length) return;
  if (batchBuffer.length >= BATCH_SIZE || force) {
    self.postMessage({ type:'batch', rows: batchBuffer, fileIndex: fileIndex, processed: stats.processed, total: totalRows });
    batchBuffer = [];
  }
}

function reportProgress() {
  var now = Date.now();
  var elapsed = Math.max((now - lastProgressTs) / 1000, 0.001);
  var rowsPerSec = Math.round((stats.processed - lastProgressRows) / elapsed);
  lastProgressTs = now;
  lastProgressRows = stats.processed;
  self.postMessage({
    type:'progress', fileIndex: fileIndex,
    processed: stats.processed, total: totalRows,
    rowsPerSec: rowsPerSec,
    duplicates: stats.duplicates,
    invalid: stats.invalid,
    filtered: stats.filtered
  });
}

// --- Entry point ---
self.onmessage = function(e) {
  var data = e.data;
  if (data.cmd !== 'parse') return;

  BATCH_SIZE = data.batchSize || 800;
  fileIndex  = data.fileIdx   || 0;
  stats      = { processed:0, inserted:0, duplicates:0, invalid:0, filtered:0 };
  batchBuffer = [];
  headers = []; headerCount = 0; totalRows = 0;
  lastProgressTs = Date.now(); lastProgressRows = 0;
  // Reset bloom filter for each new file
  bloomBuf.fill(0);
  totalRows = data.file.size ? Math.round(data.file.size / 80) : 0;

  Papa.parse(data.file, {
    header: false,
    skipEmptyLines: true,
    chunkSize: 512 * 1024,

    chunk: function(results) {
      var rows = results.data;

      // First row = headers
      if (headers.length === 0 && rows.length > 0) {
        headers = rows[0].map(canonicalKey);
        headerCount = headers.length;
        rows = rows.slice(1);
      }

      for (var i = 0; i < rows.length; i++) {
        stats.processed++;
        var res = processRow(rows[i]);
        if (!res.row) {
          if (res.reason === 'filtered') stats.filtered++;
          else stats.invalid++;
          continue;
        }

        // Bloom filter: deduplicar por RUT Y por teléfono.
        // RUT = misma persona; teléfono = evitar enviar dos mensajes al mismo número.
        var rutKey   = 'R:' + res.row.document;
        var phoneKey = res.row.phone ? ('P:' + res.row.phone) : null;

        if (bloomHas(rutKey) || (phoneKey && bloomHas(phoneKey))) {
          stats.duplicates++;
        } else {
          bloomAdd(rutKey);
          if (phoneKey) bloomAdd(phoneKey);
          stats.inserted++;
        }

        batchBuffer.push(res.row);
        flushBatch(false);
      }

      if (Date.now() - lastProgressTs >= 500) reportProgress();
    },

    complete: function() {
      flushBatch(true);
      reportProgress();
      self.postMessage({
        type:'done', fileIndex: fileIndex,
        total: stats.processed,
        inserted: stats.inserted,
        duplicates: stats.duplicates,
        invalid: stats.invalid,
        filtered: stats.filtered
      });
    },

    error: function(err) {
      self.postMessage({ type:'error', message: err.message || String(err), fileIndex: fileIndex });
    }
  });
};