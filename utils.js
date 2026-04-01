/**
 * utils.js — Utilidades compartidas (ES module)
 *
 * Exporta:
 *   normalizePhone, normalizeDocument, normalizeKey, canonicalKey
 *   renderTemplate, downloadBlobStream
 *   generateSyntheticCSV — generador de CSV para pruebas de carga
 */

/* ─── NORMALIZACIÓN DE CABECERAS ────────────────────────────────*/
const ACCENT_MAP = {á:'a',é:'e',í:'i',ó:'o',ú:'u',ü:'u',ñ:'n',
                    Á:'a',É:'e',Í:'i',Ó:'o',Ú:'u',Ü:'u',Ñ:'n'};

export function normalizeKey(k) {
  return String(k)
    .replace(/^\uFEFF/, '')      // quitar BOM
    .trim()
    .toLowerCase()
    .replace(/[áéíóúüñÁÉÍÓÚÜÑ]/g, c => ACCENT_MAP[c] || c)
    .replace(/[\s\-\.]+/g, '_')
    .replace(/[^\w]/g, '');
}

const FIELD_ALIASES = {
  phone_number:'phone', telefono:'phone', tel:'phone',
  mobile:'phone', celular:'phone', cel:'phone', numero:'phone',
  alternate_number:'altPhone',
  id_card_number:'document', rut:'document', dni:'document',
  cedula:'document', documento:'document', nro_doc:'document',
  id_card_type_str:'docType',
  nombre:'name', fullname:'name',
  correo:'email', mail:'email',
};

export function canonicalKey(k) {
  const norm = normalizeKey(k);
  return FIELD_ALIASES[norm] || norm;
}

/* ─── NORMALIZACIÓN DE TELÉFONO ────────────────────────────────*/
export function normalizePhone(raw) {
  if (raw == null) return '';
  const s = String(raw).trim().replace(/^\uFEFF/, '');
  if (/^null$/i.test(s) || s === '' || s === '-' || s === 'N/A') return '';
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length < 7) return '';
  return hasPlus ? '+' + digits : digits;
}

/* ─── RUT CHILENO ────────────────────────────────────────────────
 *
 * Formatos que pueden venir del CSV:
 *   "18.537.533-1"  → con puntos y guion          (más común)
 *   "19740398-5"    → sin puntos, con guion
 *   "125761453"     → sin puntos ni guion (último dígito = verificador)
 *   "13.186.874-k"  → k minúscula
 *
 * Formato de almacenamiento (normalizado para dedupe):
 *   "18537533-1"    → sin puntos, con guion, K mayúscula
 *
 * Formato de visualización: igual al normalizado.
 * No mostramos puntos (formato moderno SII).
 */

/**
 * Detecta si el tipo de documento indica RUT chileno.
 * Acepta: 'Rut', 'RUT', 'rut', 'CI', 'cedula', etc.
 * Rechaza: 'Pasaporte', 'Passport', 'DNI' (extranjeros), etc.
 */
export function isRUTDocType(docTypeStr) {
  if (!docTypeStr) return false;
  const s = String(docTypeStr).trim().toLowerCase()
    .replace(/[áéíóúü]/g, c => ({á:'a',é:'e',í:'i',ó:'o',ú:'u',ü:'u'}[c]||c));
  // Excluir explícitamente pasaportes y documentos extranjeros
  if (/pasaporte|passport|foreig|extranjero/.test(s)) return false;
  // Aceptar RUT, CI, cedula, carnet
  return /rut|r\.u\.t|cedula|carnet|c\.i\.|^ci$/.test(s);
}

/**
 * Normaliza un RUT chileno a formato "XXXXXXXX-V" (sin puntos, con guion, K mayúscula).
 * Retorna null si el valor no parece un RUT válido.
 */
export function normalizeRUT(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (/^null$/i.test(s) || s === '' || s === '-') return null;

  // Si contiene letras que no sean K, es un pasaporte/código extranjero → rechazar
  // Permitir solo dígitos, puntos, guiones y la letra K
  if (/[A-JL-Z]/.test(s)) return null;

  // Quitar puntos y espacios
  let clean = s.replace(/\./g, '').replace(/\s/g, '');

  let body, ver;
  if (clean.includes('-')) {
    // Tiene guion: split en body y verificador
    const parts = clean.split('-');
    body = parts[0];
    ver  = parts[1];
  } else {
    // Sin guion: el último carácter es el verificador
    ver  = clean.slice(-1);
    body = clean.slice(0, -1);
  }

  // Validar: body solo dígitos, ver solo dígito o K
  if (!/^\d+$/.test(body)) return null;
  if (!/^[\dK]$/.test(ver)) return null;

  // RUT chileno: mínimo 1.000.000 (persona natural) o empresa
  const num = parseInt(body, 10);
  if (num < 1_000_000 || num > 99_999_999) return null;

  return `${body}-${ver}`;
}

/**
 * Formatea un RUT normalizado para mostrar en pantalla.
 * "18537533-1" → "18537533-1"  (ya está en formato display, sin puntos)
 * Se mantiene sin puntos por ser el formato moderno del SII.
 */
export function formatRUT(normalized) {
  if (!normalized) return '—';
  return normalized; // sin puntos, con guion: ej. "18537533-1"
}

/** @deprecated usa normalizeRUT */
export function normalizeDocument(raw) {
  return normalizeRUT(raw) || '';
}

/* ─── DETECCIÓN DEL CAMPO DE TELÉFONO ──────────────────────────*/
export function detectPhoneField(row) {
  const keys = Object.keys(row || {});
  const priority = ['phone','phone_number','alternate_number','telefono','tel','mobile','celular'];
  for (const p of priority) {
    const found = keys.find(k => normalizeKey(k) === p);
    if (found) return found;
  }
  // Heurística: primer campo con 7+ dígitos
  for (const k of keys) {
    const digits = String(row[k] ?? '').replace(/[^\d]/g, '');
    if (digits.length >= 7) return k;
  }
  return null;
}

/* ─── RENDER DE PLANTILLAS ─────────────────────────────────────*/
export function renderTemplate(body, data = {}) {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? '');
}

/* ─── GENERACIÓN DE ENLACE SMS ─────────────────────────────────*/
export function buildSMSLink(phone, body) {
  return `sms:${phone}?body=${encodeURIComponent(body)}`;
}

/* ─── GENERACIÓN DE ENLACE WHATSAPP ────────────────────────────*/
export function buildWALink(phone, body) {
  // wa.me espera teléfono sin + ni espacios
  const clean = phone.replace(/[^\d]/g, '');
  return `https://wa.me/${clean}?text=${encodeURIComponent(body)}`;
}

/* ─── DESCARGA EN STREAMING (BLOB) ─────────────────────────────
 * Para archivos grandes (>500MB) los navegadores pueden rechazar
 * URL.createObjectURL sobre Blobs muy grandes.
 * Usamos el patrón de acumular chunks y crear el Blob al final.
 * Para producciones >100MB recomendamos StreamSaver.js o un backend.
 */
export function downloadBlobStream(filename, chunks = [], mime = 'text/csv;charset=utf-8;') {
  const blob = new Blob(chunks, { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ─── FORMATO DE NÚMEROS ────────────────────────────────────────*/
export function fmtNum(n) {
  return Number(n || 0).toLocaleString('es-CL');
}

export function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('es-CL');
}

/* ─── GENERADOR DE CSV SINTÉTICO PARA PRUEBAS DE CARGA ─────────
 * Genera un CSV en memoria con N filas aleatorias.
 * Uso: const file = generateSyntheticCSV(100000);
 *      // file es un Blob → se puede pasar a Papa.parse o al Worker
 *
 * Para 1M filas a ~100 bytes/fila ≈ 100 MB en memoria.
 * Recomendado: generar y liberar en chunks usando el Worker.
 */
const NAMES = ['Ana','Luis','María','Carlos','Sofía','Pedro','Laura','Jorge','Isabel','Diego'];
const LASTNAMES = ['González','Muñoz','Rojas','Díaz','Pérez','Soto','Contreras','Silva','Martínez','Flores'];

export function generateSyntheticCSV(n = 10000) {
  const header = 'id,name,age,phone_number,email,alternate_number,id_card_type_str,id_card_number,status\n';
  const lines = [header];

  for (let i = 1; i <= n; i++) {
    const name = NAMES[i % NAMES.length] + ' ' + LASTNAMES[(i * 3) % LASTNAMES.length];
    const phone = '9' + String(10000000 + i).slice(1); // 9XXXXXXXX
    const age = 18 + (i % 60);
    const email = name.toLowerCase().replace(/\s/g,'') + '@test.cl';
    const rut = `${i}.${String(i).padStart(3,'0')}-K`;

    // ~5% de duplicados intencionales para probar dedupe
    const isDuplicate = i > 1 && i % 20 === 0;
    const phoneOut = isDuplicate ? '9' + String(10000000 + i - 1).slice(1) : phone;

    lines.push(`${i},"${name}",${age},${phoneOut},${email},,Rut,${rut},pending\n`);

    // Liberar referencias cada 10k para no saturar el call stack
    if (i % 50000 === 0) {
      // No podemos yield aquí, pero podemos truncar y retornar parcial
    }
  }

  return new Blob(lines, { type: 'text/csv;charset=utf-8;' });
}

/* ─── PARSER DE CSV SIMPLE (SIN PAPAPARSE) PARA CABECERAS ──────
 * Parsea solo la primera fila de un File para extraer cabeceras.
 * Útil para mostrar preview antes de importar.
 */
export async function readCSVHeaders(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result || '';
      const firstLine = text.split('\n')[0];
      const cols = firstLine.split(',').map(c => c.trim().replace(/^"|"$/g,''));
      resolve(cols);
    };
    // Leer solo los primeros 4 KB para obtener la primera línea
    reader.readAsText(file.slice(0, 4096), 'latin1');
  });
}

/* ─── TOAST HELPER ──────────────────────────────────────────────*/
export function showToast(msg, type = 'info', duration = 3000) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `toast t-${type}`;
  div.textContent = msg;
  div.setAttribute('role', 'alert');
  container.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transition = 'opacity 0.3s';
    setTimeout(() => div.remove(), 300);
  }, duration);
}