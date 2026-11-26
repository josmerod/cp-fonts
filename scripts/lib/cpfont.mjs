// Reading CrossPoint .cpfont v4 files — just enough of the format to check
// what the converter produced. Pure functions, no I/O.
//
// Everything is little-endian (crossglyph's cpfont/convert.py):
//   header      32 B   magic "CPFONT\0\0", u16 version, u16 flags, u8 styleCount, 19 B reserved
//   style TOC   32 B per style
//                 u8 styleId, u32 intervalCount, u32 glyphCount, u8 advanceY, i16 ascender,
//                 i16 descender, u16 kernLeft, u16 kernRight, u8 kernLeftClasses,
//                 u8 kernRightClasses, u8 ligatureCount, u32 dataOffset
//   per style   at dataOffset: intervals (12 B: u32 first, u32 last, u32 offset), then
//               glyph records (16 B: u8 width, u8 height, u16 advanceX, i16 left, i16 top,
//               u16 dataLength, 2 B pad, u32 dataOffset), then left and right kerning
//               (3 B each), the kerning class matrix, ligatures (8 B each) and the
//               2-bit glyph bitmaps the records point into

export const STYLE_NAMES = ['regular', 'bold', 'italic', 'bolditalic'];

// Pixels that are not white in a stretch of 2-bit bitmap (white is 0).
function ink(bytes, start, end) {
  let n = 0;
  for (let i = start; i < end; i++) {
    const v = bytes[i];
    if (v) n += (v & 3 ? 1 : 0) + (v & 12 ? 1 : 0) + (v & 48 ? 1 : 0) + (v & 192 ? 1 : 0);
  }
  return n;
}

// → one { style, glyphs } per style, glyphs being Map(<codepoint> → { width, height, length, ink });
//   null for a file that is not a .cpfont v4.
export function readCpfont(bytes) {
  if (bytes.length < 32 || bytes.toString('latin1', 0, 8) !== 'CPFONT\0\0' || bytes.readUInt16LE(8) !== 4) return null;
  const styles = [];
  for (let s = 0; s < bytes.readUInt8(12); s++) {
    const toc = 32 + s * 32;
    const intervalCount = bytes.readUInt32LE(toc + 4), glyphCount = bytes.readUInt32LE(toc + 8);
    const data = bytes.readUInt32LE(toc + 24);
    const records = data + intervalCount * 12;
    const bitmaps = records + glyphCount * 16 + bytes.readUInt16LE(toc + 17) * 3 + bytes.readUInt16LE(toc + 19) * 3
      + bytes.readUInt8(toc + 21) * bytes.readUInt8(toc + 22) + bytes.readUInt8(toc + 23) * 8;
    if (bitmaps > bytes.length) return null;
    const glyphs = new Map();
    styles.push({ style: bytes.readUInt8(toc), glyphs });
    for (let i = 0; i < intervalCount; i++) {
      const at = data + i * 12;
      const first = bytes.readUInt32LE(at), last = bytes.readUInt32LE(at + 4), offset = bytes.readUInt32LE(at + 8);
      for (let cp = first; cp <= last; cp++) {
        const g = records + (offset + cp - first) * 16;
        const start = bitmaps + bytes.readUInt32LE(g + 12), end = start + bytes.readUInt16LE(g + 8);
        if (end > bytes.length) return null;
        glyphs.set(cp, { width: bytes[g], height: bytes[g + 1], length: end - start, ink: ink(bytes, start, end) });
      }
    }
  }
  return styles;
}

const LATIN = /\p{Script=Latin}/u, LETTER = /\p{L}/u;

// Per style, the Latin letters and the digits that a file maps but draws as
// nothing: [{ style, ascii, latin, chars }] for the styles that have any.
// `latin` counts them all, `ascii` those of ASCII (a subset), `chars` lists
// the code points.
export function blankGlyphs(cpfont) {
  const out = [];
  for (const { style, glyphs } of cpfont) {
    const chars = [];
    for (const [cp, g] of glyphs) {
      if (g.ink) continue;
      if (cp >= 0x30 && cp <= 0x39) chars.push(cp);
      else if (LETTER.test(String.fromCodePoint(cp)) && LATIN.test(String.fromCodePoint(cp))) chars.push(cp);
    }
    if (chars.length) out.push({ style: STYLE_NAMES[style] || style, latin: chars.length, ascii: chars.filter((cp) => cp < 0x80).length, chars });
  }
  return out;
}

// What makes a style unusable: its letters coming out as gaps. A few blank
// glyphs are normal — sources map rare characters to empty outlines — so the
// count is what tells a font whose hinting collapses its outlines apart, and
// the ASCII range gets no allowance at all.
export const MAX_BLANK_ASCII = 0;
export const MAX_BLANK_LATIN = 4;
export const isUnusable = ({ ascii, latin }) => ascii > MAX_BLANK_ASCII || latin > MAX_BLANK_LATIN;
