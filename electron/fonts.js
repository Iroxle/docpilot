'use strict';
/**
 * Fonts like in Word: all installed Windows fonts (for all users and for this user only)
 * plus the cloud fonts downloaded by Office (e.g. Aptos).
 * Only the headers of the files are read (names, style, license bits), not the whole fonts.
 * Plus the default font from Word's Normal.dotm template.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WIN = process.env.WINDIR || 'C:\\Windows';
const LOCAL = process.env.LOCALAPPDATA || '';
const FONT_DIRS = [
  { dir: path.join(WIN, 'Fonts'), deep: false, cloud: false },
  LOCAL && { dir: path.join(LOCAL, 'Microsoft', 'Windows', 'Fonts'), deep: false, cloud: false },
  LOCAL && { dir: path.join(LOCAL, 'Microsoft', 'FontCache', '4', 'CloudFonts'), deep: true, cloud: true },
].filter(Boolean);
const EXT = /\.(ttf|otf|ttc)$/i;
const CACHE_VERSION = 2;

async function listFiles({ dir, deep, cloud }) {
  const out = [];
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (deep) out.push(...await listFiles({ dir: p, deep: false, cloud })); }
    else if (EXT.test(e.name)) out.push({ file: p, cloud });
  }
  return out;
}

async function readAt(fh, pos, len) {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fh.read(b, 0, len, pos);
  return b.subarray(0, bytesRead);
}

function decodeName(b, platform) {
  if (platform === 3 || platform === 0) {
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
    return s;
  }
  return b.toString('latin1');
}

/** Reads family, style and license bits of a font starting at position off (several fonts per file for .ttc). */
async function readFace(fh, off) {
  const head = await readAt(fh, off, 12);
  if (head.length < 12) return null;
  const n = head.readUInt16BE(4);
  const dir = await readAt(fh, off + 12, n * 16);
  const tables = {};
  for (let i = 0; i < n && (i + 1) * 16 <= dir.length; i++) {
    tables[dir.toString('latin1', i * 16, i * 16 + 4)] = { offset: dir.readUInt32BE(i * 16 + 8), length: dir.readUInt32BE(i * 16 + 12) };
  }
  if (!tables.name || !(tables.glyf || tables['CFF '] || tables.CFF2)) return null;
  const nt = await readAt(fh, tables.name.offset, Math.min(tables.name.length, 1 << 20));
  const count = nt.readUInt16BE(2); const strOff = nt.readUInt16BE(4);
  const pick = (id) => {
    let best = null; let rank = 99;
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      if (r + 12 > nt.length) break;
      const platform = nt.readUInt16BE(r); const lang = nt.readUInt16BE(r + 4); const nameId = nt.readUInt16BE(r + 6);
      if (nameId !== id) continue;
      const k = platform === 3 ? (lang === 0x409 ? 0 : 1) : platform === 0 ? 2 : platform === 1 && lang === 0 ? 3 : 9;
      if (k < rank) {
        const len = nt.readUInt16BE(r + 8); const o = strOff + nt.readUInt16BE(r + 10);
        if (o + len <= nt.length) { rank = k; best = decodeName(nt.subarray(o, o + len), platform); }
      }
    }
    return best;
  };
  let symbol = false;
  for (let i = 0; i < count; i++) { const r = 6 + i * 12; if (r + 12 <= nt.length && nt.readUInt16BE(r) === 3 && nt.readUInt16BE(r + 2) === 0) { symbol = true; break; } }
  const family = (pick(1) || '').trim();
  const sub = (pick(2) || 'Regular').trim();
  if (!family) return null;
  let fsType = 0; let bold = /bold/i.test(sub); let italic = /italic|oblique/i.test(sub);
  if (tables['OS/2'] && tables['OS/2'].length >= 64) {
    const os2 = await readAt(fh, tables['OS/2'].offset, 64);
    if (os2.length >= 64) {
      fsType = os2.readUInt16BE(8);
      const sel = os2.readUInt16BE(62);
      bold = !!(sel & 0x20); italic = !!(sel & 0x01);
    }
  }
  // Bit 1 (0x2): license forbids embedding. Bit 9 (0x200): only bitmaps embeddable. Such fonts are not used.
  const embeddable = !(fsType & 0x0002) && !(fsType & 0x0200);
  return { family, sub, bold, italic, embeddable, symbol, offset: off, variable: !!tables.fvar };
}

async function readFile(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const sig = await readAt(fh, 0, 12);
    if (sig.length < 12) return [];
    if (sig.toString('latin1', 0, 4) === 'ttcf') {
      const num = Math.min(sig.readUInt32BE(8), 64);
      const offs = await readAt(fh, 12, num * 4);
      const out = [];
      for (let i = 0; i < num; i++) { const f = await readFace(fh, offs.readUInt32BE(i * 4)).catch(() => null); if (f) out.push({ ...f, index: i }); }
      return out;
    }
    const f = await readFace(fh, 0);
    return f ? [{ ...f, index: 0 }] : [];
  } finally { await fh.close(); }
}

/**
 * Font catalog. Grouped like in Word by the font's family name (e.g. "Arial",
 * "Arial Black", "Segoe UI Semibold"), with the four faces Regular, Bold, Italic, Bold Italic.
 */
class FontCatalog {
  constructor(cacheFile) { this.cacheFile = cacheFile; this.faces = []; this.ready = null; }

  load() {
    if (!this.ready) this.ready = this.scan().catch(() => ({ families: [] }));
    return this.ready;
  }

  async scan() {
    let cache = {};
    try { const c = JSON.parse(await fs.promises.readFile(this.cacheFile, 'utf8')); if (c.version === CACHE_VERSION) cache = c.files || {}; } catch { /* neu aufbauen */ }
    const next = {};
    const faces = [];
    for (const d of FONT_DIRS) {
      for (const { file, cloud } of await listFiles(d)) {
        let st;
        try { st = await fs.promises.stat(file); } catch { continue; }
        const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
        let list = cache[file]?.stamp === stamp ? cache[file].faces : null;
        if (!list) { try { list = await readFile(file); } catch { list = []; } }
        next[file] = { stamp, faces: list };
        for (const f of list) faces.push({ ...f, file, cloud, size: st.size });
      }
    }
    try {
      await fs.promises.mkdir(path.dirname(this.cacheFile), { recursive: true });
      await fs.promises.writeFile(this.cacheFile, JSON.stringify({ version: CACHE_VERSION, files: next }));
    } catch { /* the cache is only a speed-up */ }

    const byName = new Map();
    for (const f of faces) {
      if (f.family.startsWith('@')) continue;
      const key = f.family.toLowerCase();
      let fam = byName.get(key);
      if (!fam) { fam = { name: f.family, faces: [null, null, null, null], embeddable: false, symbol: f.symbol, cloud: f.cloud, size: 0 }; byName.set(key, fam); }
      const k = (f.bold ? 1 : 0) + (f.italic ? 2 : 0);
      // First match wins: Windows fonts before user fonts before cloud fonts.
      if (fam.faces[k] !== null) continue;
      const id = this.faces.length;
      this.faces.push({ file: f.file, offset: f.offset, ttc: /\.ttc$/i.test(f.file) });
      fam.faces[k] = { id, embeddable: f.embeddable };
      if (k === 0) fam.size = f.size;
    }
    const families = [];
    for (const fam of byName.values()) {
      // Without a regular face, the first available face counts as regular (e.g. bold-only fonts).
      if (!fam.faces[0]) fam.faces[0] = fam.faces.find(Boolean);
      fam.embeddable = fam.faces.some((x) => x && x.embeddable);
      families.push({
        name: fam.name, symbol: fam.symbol, cloud: fam.cloud, embeddable: fam.embeddable, size: fam.size,
        faces: fam.faces.map((x) => (x && x.embeddable ? x.id : null)),
        preview: fam.faces[0] ? fam.faces[0].id : null,
      });
    }
    families.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
    return { families };
  }

  /** Data of a face. From .ttc collections, the one font is extracted as a standalone file. */
  async data(id) {
    const f = this.faces[id];
    if (!f) return null;
    const buf = await fs.promises.readFile(f.file);
    return f.ttc ? extractFace(buf, f.offset) : buf;
  }
}

function extractFace(buf, off) {
  const n = buf.readUInt16BE(off + 4);
  const recs = [];
  for (let i = 0; i < n; i++) {
    const r = off + 12 + i * 16;
    recs.push({ tag: buf.subarray(r, r + 4), sum: buf.readUInt32BE(r + 4), offset: buf.readUInt32BE(r + 8), length: buf.readUInt32BE(r + 12) });
  }
  const headLen = 12 + n * 16;
  let total = headLen;
  for (const r of recs) total += (r.length + 3) & ~3;
  const out = Buffer.alloc(total);
  buf.copy(out, 0, off, off + 12);
  let pos = headLen;
  recs.forEach((r, i) => {
    const d = 12 + i * 16;
    r.tag.copy(out, d); out.writeUInt32BE(r.sum, d + 4); out.writeUInt32BE(pos, d + 8); out.writeUInt32BE(r.length, d + 12);
    buf.copy(out, pos, r.offset, r.offset + r.length);
    pos += (r.length + 3) & ~3;
  });
  return out;
}

// --- Default font from Word --------------------------------------------------------------

/** Minimal ZIP reader for single entries (Normal.dotm is a ZIP archive). */
function unzipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10); const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const n = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (n === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}

const attr = (xml, re) => { const m = re.exec(xml || ''); return m ? m[1] : null; };
const unxml = (s) => s && s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/**
 * Default font like in Word: from Normal.dotm (document defaults and the "Normal" style,
 * theme fonts from the theme). If the template is missing, Word's built-in default applies.
 */
function wordDefaults() {
  try { return parseNormal(fs.readFileSync(path.join(process.env.APPDATA || '', 'Microsoft', 'Templates', 'Normal.dotm'))); }
  catch { return { body: null, heading: null, size: null, source: 'word-default' }; }
}
function parseNormal(buf) {
  const out = { body: null, heading: null, size: null, source: 'word-default' };
  try {
    const styles = unzipEntry(buf, 'word/styles.xml');
    if (!styles) return out;
    const theme = unzipEntry(buf, 'word/theme/theme1.xml') || '';
    const minor = unxml(attr(theme, /<a:minorFont>\s*<a:latin typeface="([^"]*)"/));
    const major = unxml(attr(theme, /<a:majorFont>\s*<a:latin typeface="([^"]*)"/));
    const fontOf = (rPr) => {
      if (!rPr) return null;
      const direct = unxml(attr(rPr, /<w:rFonts\b[^>]*\bw:ascii="([^"]*)"/));
      if (direct) return direct;
      const th = attr(rPr, /<w:rFonts\b[^>]*\bw:asciiTheme="([^"]*)"/);
      if (th) return /^major/i.test(th) ? major : minor;
      return null;
    };
    const sizeOf = (rPr) => { const v = attr(rPr, /<w:sz\b[^>]*\bw:val="(\d+)"/); return v ? Number(v) / 2 : null; };
    const defaults = attr(styles, /<w:rPrDefault>\s*<w:rPr>([\s\S]*?)<\/w:rPr>/);
    const normal = attr(styles, /<w:style\b[^>]*w:type="paragraph"[^>]*w:default="1"[^>]*>([\s\S]*?)<\/w:style>/);
    const normalRPr = attr(normal, /<w:rPr>([\s\S]*?)<\/w:rPr>/);
    out.body = fontOf(normalRPr) || fontOf(defaults) || minor;
    out.size = sizeOf(normalRPr) || sizeOf(defaults) || 10;
    out.heading = major;
    out.source = 'normal.dotm';
  } catch { /* unlesbare Vorlage: Words eingebauter Standard */ }
  return out;
}

module.exports = { FontCatalog, wordDefaults, parseNormal, extractFace, unzipEntry };
