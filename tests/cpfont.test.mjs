import assert from 'node:assert/strict';
import test from 'node:test';
import { blankGlyphs, isUnusable, readCpfont } from '../scripts/lib/cpfont.mjs';

// A v4 file with the given styles, each { styleId, intervals }, an interval
// being [firstCodePoint, glyphs] for consecutive characters. A glyph is
// [width, height, ink]: ink 0 is a box of white pixels, otherwise black.
function cpfont(styles) {
  const head = Buffer.alloc(32);
  head.write('CPFONT\0\0', 0, 'latin1');
  head.writeUInt16LE(4, 8);
  head.writeUInt8(styles.length, 12);
  const toc = Buffer.alloc(32 * styles.length);
  const parts = styles.map((s, i) => {
    const total = s.intervals.reduce((n, [, glyphs]) => n + glyphs.length, 0);
    const records = Buffer.alloc(12 * s.intervals.length + total * 16);
    const bitmaps = [];
    let offset = 0, index = 0;
    for (const [n, [first, glyphs]] of s.intervals.entries()) {
      records.writeUInt32LE(first, n * 12);
      records.writeUInt32LE(first + glyphs.length - 1, n * 12 + 4);
      records.writeUInt32LE(index, n * 12 + 8);
      for (const [w, h, ink] of glyphs) {
        const r = s.intervals.length * 12 + index * 16, bytes = Math.ceil(w * h / 4);
        records.writeUInt8(w, r);
        records.writeUInt8(h, r + 1);
        records.writeUInt16LE(bytes, r + 8);
        records.writeUInt32LE(offset, r + 12);
        const bitmap = ink ? Buffer.alloc(bytes, 0xff) : Buffer.alloc(bytes);
        if (ink && (w * h) % 4) bitmap[bytes - 1] = (1 << (2 * ((w * h) % 4))) - 1; // its padding stays white
        bitmaps.push(bitmap);
        offset += bytes;
        index++;
      }
    }
    toc.writeUInt8(s.styleId, i * 32);
    toc.writeUInt32LE(s.intervals.length, i * 32 + 4);
    toc.writeUInt32LE(total, i * 32 + 8);
    return Buffer.concat([records, ...bitmaps]);
  });
  let offset = 32 + toc.length;
  styles.forEach((_, i) => { toc.writeUInt32LE(offset, i * 32 + 24); offset += parts[i].length; });
  return Buffer.concat([head, toc, ...parts]);
}

test('reads the styles and glyphs of a v4 file', () => {
  const file = cpfont([
    { styleId: 0, intervals: [[0x61, [[3, 5, 1], [0, 0, 0]]]] },
    { styleId: 1, intervals: [[0x41, [[4, 7, 1]]]] },
  ]);
  const styles = readCpfont(file);
  assert.deepEqual(styles.map((s) => s.style), [0, 1]);
  assert.deepEqual([...styles[0].glyphs], [
    [0x61, { width: 3, height: 5, length: 4, ink: 15 }],
    [0x62, { width: 0, height: 0, length: 0, ink: 0 }],
  ]);
  assert.equal(styles[1].glyphs.get(0x41).ink, 28);
});

test('refuses what is not a .cpfont v4', () => {
  const file = cpfont([{ styleId: 0, intervals: [[0x41, [[2, 2, 1]]]] }]);
  assert.equal(readCpfont(file.subarray(0, 20)), null);
  assert.equal(readCpfont(Buffer.from('not a font at all, really not one')), null);
  const otherVersion = Buffer.from(file);
  otherVersion.writeUInt16LE(3, 8);
  assert.equal(readCpfont(otherVersion), null);
  const truncated = Buffer.from(file);
  truncated.writeUInt32LE(1 << 20, 32 + 24); // the style's data offset, beyond the end of the file
  assert.equal(readCpfont(truncated), null);
});

test('lists the Latin letters and digits drawn as nothing, per style', () => {
  // Regular: a drawn 'd' and a blank 'e'. Bold: a blank 'A', then a drawn
  // 'D', an 'e' that is a white box, a blank 'F', and a blank 'À' after a gap.
  // Italic: a blank '0' and a blank omega, which is Greek and not counted.
  const file = cpfont([
    { styleId: 0, intervals: [[0x64, [[3, 5, 1], [0, 0, 0]]]] },
    { styleId: 1, intervals: [[0x41, [[0, 0, 0]]], [0x44, [[4, 6, 1], [3, 5, 0], [0, 0, 0]]], [0xc0, [[0, 0, 0]]]] },
    { styleId: 2, intervals: [[0x30, [[0, 0, 0]]], [0x3a9, [[0, 0, 0]]]] },
  ]);
  assert.deepEqual(blankGlyphs(readCpfont(file)), [
    { style: 'regular', latin: 1, ascii: 1, chars: [0x65] },
    { style: 'bold', latin: 4, ascii: 3, chars: [0x41, 0x45, 0x46, 0xc0] },
    { style: 'italic', latin: 1, ascii: 1, chars: [0x30] },
  ]);
});

test('a few blank glyphs are tolerated, a broken alphabet is not', () => {
  assert.equal(isUnusable({ ascii: 0, latin: 0 }), false);
  assert.equal(isUnusable({ ascii: 0, latin: 4 }), false); // rare letters the source maps to nothing
  assert.equal(isUnusable({ ascii: 0, latin: 5 }), true);
  assert.equal(isUnusable({ ascii: 1, latin: 1 }), true); // one ASCII letter is a hole in every page
});
