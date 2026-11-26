// CCITT Group 4 (T.6) encoder for black-and-white images: lossless and usually far smaller than Flate for scans.
// Input: packed rows of 1-bit samples (each row starts on a new byte), bit 0 = black, as CCITTFaxDecode with
// /BlackIs1 false decodes them again.

const T = (s) => s.split(' ').map((c) => [parseInt(c, 2), c.length]);
// Terminating codes 0-63 and makeup codes 64-1728 (T.4 tables 2 and 3).
const WHITE_TERM = T('00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100');
const WHITE_MAKEUP = T('11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011');
const BLACK_TERM = T('0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111');
const BLACK_MAKEUP = T('0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101');
// Makeup codes 1792-2560, the same for both colours.
const EXT_MAKEUP = T('00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111');
const VERTICAL = { '-3': [0b0000010, 7], '-2': [0b000010, 6], '-1': [0b010, 3], 0: [1, 1], 1: [0b011, 3], 2: [0b000011, 6], 3: [0b0000011, 7] };
const PASS = [0b0001, 4];
const HORIZONTAL = [0b001, 3];
const EOL = [1, 12];

class BitWriter {
  constructor(size) { this.buf = new Uint8Array(Math.max(64, size)); this.len = 0; this.acc = 0; this.n = 0; }
  put([code, bits]) {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      if (++this.n === 8) {
        if (this.len === this.buf.length) { const b = new Uint8Array(this.buf.length * 2); b.set(this.buf); this.buf = b; }
        this.buf[this.len++] = this.acc; this.acc = 0; this.n = 0;
      }
    }
  }
  bytes() { while (this.n) this.put([0, 1]); return this.buf.slice(0, this.len); }
}

function putRun(w, run, black) {
  const term = black ? BLACK_TERM : WHITE_TERM; const makeup = black ? BLACK_MAKEUP : WHITE_MAKEUP;
  while (run >= 2560) { w.put(EXT_MAKEUP[12]); run -= 2560; }
  if (run >= 1792) { const k = Math.floor((run - 1792) / 64); w.put(EXT_MAKEUP[k]); run -= 1792 + k * 64; }
  else if (run >= 64) { const k = Math.floor(run / 64) - 1; w.put(makeup[k]); run -= (k + 1) * 64; }
  w.put(term[run]);
}

/** The changing elements of a row: positions where the colour differs from the pixel before (white before the row). */
function changes(data, row, width, out) {
  let n = 0; let prev = 1; // 1 = white
  for (let x = 0; x < width; x++) {
    const v = (data[row + (x >> 3)] >> (7 - (x & 7))) & 1;
    if (v !== prev) { out[n++] = x; prev = v; }
  }
  out[n] = width; out[n + 1] = width;
  return n;
}

/** Encodes packed 1-bit rows (bit 0 = black) as CCITT Group 4 with an end-of-block code. */
export function encodeG4(data, width, height) {
  const rowBytes = Math.ceil(width / 8);
  const w = new BitWriter(rowBytes * height / 8);
  let ref = new Int32Array(width + 2); let cur = new Int32Array(width + 2);
  ref[0] = width; ref[1] = width; // an imaginary white row above the image
  for (let y = 0; y < height; y++) {
    const n = changes(data, y * rowBytes, width, cur);
    let a0 = -1; let color = 0; // 0 white, 1 black: the colour of a0
    let ia = 0; // index of the first changing element of the coding line right of a0
    let ib = 0;
    for (;;) {
      while (ia < n && cur[ia] <= a0) ia++;
      const a1 = cur[ia]; const a2 = cur[ia + 1];
      // b1: the first changing element of the reference line right of a0 with the colour opposite to a0's;
      // changing elements at even indexes turn black, at odd indexes white.
      ib = 0;
      while (ref[ib] < width && (ref[ib] <= a0 || (ib & 1) !== color)) ib++;
      const b1 = ref[ib]; const b2 = b1 < width ? ref[ib + 1] : width;
      if (b2 < a1) { w.put(PASS); a0 = b2; continue; }
      const d = a1 - b1;
      if (Math.abs(d) <= 3) {
        w.put(VERTICAL[d]);
        a0 = a1; color ^= 1;
      } else {
        w.put(HORIZONTAL);
        putRun(w, a1 - Math.max(a0, 0), color === 1);
        putRun(w, a2 - a1, color === 0);
        a0 = a2;
      }
      if (a0 >= width) break;
    }
    [ref, cur] = [cur, ref];
  }
  w.put(EOL); w.put(EOL);
  return w.bytes();
}
