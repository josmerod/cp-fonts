#!/usr/bin/env node
// Regenerate families.json from the WP-Fonts repo tree: every family that
// ships a Regular TTF/OTF and a license file gets an entry; existing curated
// entries (with their descriptions) are preserved.
//
// Usage: node scripts/gen-families.mjs [--dry-run]
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = 'Chairzard/WP-Fonts';
const DRY = process.argv.includes('--dry-run');

// Fetch the full tree (curl: native fetch is blocked on some hosts).
const treeUrl = `https://api.github.com/repos/${UPSTREAM}/git/trees/HEAD?recursive=1`;
const res = spawnSync('curl', ['-sfL', '--retry', '3', treeUrl], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
if (res.status !== 0) throw new Error('cannot fetch WP-Fonts tree');
const tree = JSON.parse(res.stdout);

// Group files by folder under the two top-level categories.
const folders = new Map(); // folderPath -> {files: Set, category}
for (const e of tree.tree || []) {
  if (e.type !== 'blob') continue;
  const m = e.path.match(/^(Modified Fonts|Unmodified Fonts)\/([^/]+)\/(.+)$/);
  if (!m) continue;
  if (!folders.has(m[2])) folders.set(m[2], { category: m[1], files: new Set() });
  folders.get(m[2]).files.add(m[3]);
}

const LICENSE_RE = /^(ofl|oifl|licen[sc]e|copying|font-license|license-ofl)/i;
const config = JSON.parse(await readFile(join(ROOT, 'families.json'), 'utf8'));
const known = new Set(config.families.map((f) => f.name));

const out = [], skipped = [];
for (const [folder, { category, files }] of [...folders.entries()].sort()) {
  // The base face is -Regular, or -Roman/-Book in TeX-style families.
  let stem = null, baseName = null;
  for (const f of files) {
    const m = f.match(/^(.+)-(Regular|Roman|Book)\.(?:ttf|otf)$/i);
    if (m) { stem = m[1]; baseName = f; break; }
  }
  if (!stem) { skipped.push(folder + ' (no Regular/Roman/Book face)'); continue; }
  if (!/^[A-Za-z0-9_-]+$/.test(stem)) { skipped.push(folder + ' (bad name ' + stem + ')'); continue; }
  if (known.has(stem)) continue; // already curated
  const licenseFile = [...files].find((f) => LICENSE_RE.test(f));
  if (!licenseFile) { skipped.push(folder + ' (no license file)'); continue; }

  const exact = {};
  const styleMap = { regular: baseName, bold: 'Bold', italic: 'Italic', bolditalic: 'BoldItalic' };
  for (const [style, suffix] of Object.entries(styleMap)) {
    const f = style === 'regular'
      ? baseName
      : [...files].find((x) => x === `${stem}-${suffix}.ttf` || x === `${stem}-${suffix}.otf`);
    if (f) exact[style] = f;
  }

  known.add(stem);
  const title = category === 'Modified Fonts' ? folder.split(' - ')[0] : folder;
  out.push({
    name: stem,
    source: category + '/' + folder,
    title,
    description: '',
    license: /^o?ifl/i.test(licenseFile) ? 'OFL' : 'see license file',
    licenseFile,
    files: exact,
  });
}

console.log(`existing curated: ${config.families.length}`);
console.log(`new families: ${out.length}`);
console.log(`skipped: ${skipped.length}`);
for (const s of skipped) console.log('  - ' + s);

if (!DRY) {
  config.families = [...config.families, ...out];
  await writeFile(join(ROOT, 'families.json'), JSON.stringify(config, null, 2) + '\n');
  console.log(`families.json now has ${config.families.length} families`);
}
