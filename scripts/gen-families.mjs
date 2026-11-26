#!/usr/bin/env node
// Regenerate families.json from the WP-Fonts repo tree. A folder that ships a
// Regular face and a license becomes a family; an entry already there keeps
// its curated title, description and build settings (hinting), with its
// styles re-read from upstream.
//
// Usage: node scripts/gen-families.mjs [--dry-run] [--prune]
//
//   --dry-run  report what would change, write nothing
//   --prune    also drop the entries whose folder is gone upstream
//
// Exits 1 while families.json disagrees with upstream (an entry whose folder
// or Regular face is gone), so that cannot pass unnoticed.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTree } from './lib/github-tree.mjs';
import { sourceFile, STYLES } from './lib/plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const PRUNE = process.argv.includes('--prune');

// Folders the generic rules cannot read. `name`: a stem another family
// already uses (upstream names two fonts "WPSuperlegible"); `title`: one the
// folder name does not give; `files`: a face spelled against the rule;
// `licenseUrl`: a folder that ships no license file, where the license text
// is taken from instead (each one checked against the copyright the font
// itself carries).
const GOOGLE_FONTS = 'https://raw.githubusercontent.com/google/fonts/main/ofl';
const OVERRIDES = {
  'Modified Fonts/Atkinson Hyperlegible Mono - WP Superlegible Mono': { files: { italic: 'WPSuperlegibleMono-Italic.ttf' } },
  'Modified Fonts/Atkinson Hyperlegible Next - WP Superlegible': { name: 'WPSuperlegibleNext' },
  'Unmodified Fonts/Agrave Pro': { title: 'Agràve Pro' },
  'Unmodified Fonts/Asap Sharp': { licenseUrl: `${GOOGLE_FONTS}/asapsharp/OFL.txt` },
  'Unmodified Fonts/BreezeSans': { title: 'Breeze Sans' },
  'Unmodified Fonts/Irradiant': { licenseUrl: 'https://raw.githubusercontent.com/psb1558/Irradiant-font/master/OFL.txt' },
  'Unmodified Fonts/Joan': { licenseUrl: `${GOOGLE_FONTS}/joan/OFL.txt` },
  'Unmodified Fonts/Kufam': { licenseUrl: `${GOOGLE_FONTS}/kufam/OFL.txt` },
  'Unmodified Fonts/Questrial': { licenseUrl: `${GOOGLE_FONTS}/questrial/OFL.txt` },
  'Unmodified Fonts/Teachers': { licenseUrl: `${GOOGLE_FONTS}/teachers/OFL.txt` },
};

// ---- reading a folder ------------------------------------------------------

const FONT_RE = /\.(ttf|otf)$/i;
// A date some foundries stamp on file names (BreezeSans-Regular_20150728.ttf).
const STAMP_RE = /[-_]\d{6,}$/;
// The base face is -Regular, or -Roman/-Book/-Text/-Rg in families that spell
// it so.
const BASE_RE = /^(.+?)[-_ ]?(?:regular|roman|book|rg|text)$/i;
// A style follows the family, with or without a separator (-, _ or space).
const STYLED_RE = /[-_ ]?(?:bold|bd|italic|it)$/i;
// A weight this catalog does not take: the face of a family, never a family.
const OTHER_WEIGHT_RE = /[-_ ](thin|hairline|extralight|ultralight|light|medium|demi ?bold|semi ?bold|extrabold|ultrabold|black|heavy)$/i;
const LICENSE_RE = /^(ofl|oifl|.*licen[sc]e|copying|ufl)/i;
const OFL_BY_NAME_RE = /^(ofl|oifl)\b|sil open font license|license-ofl|font-license/i;
const STYLES_LOWER = STYLES.map((style) => style.toLowerCase());
const trim = (s) => s.replace(/[-_ ]+$/, '');

// Which style of `family` a font file's stem names, or null: another family,
// or a face this catalog does not take.
function styleOf(stem, family) {
  if (stem === family) return 'regular'; // no -Regular face: the bare name is it
  const head = `^${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[-_ ]?`;
  const base = '(?:regular|roman|book|rg|text)[-_ ]?';
  const re = (tail) => new RegExp(head + tail, 'i').test(stem);
  if (re(`(?:${base})?(?:bold|bd)[-_ ]?(?:italic|it)$`)) return 'bolditalic';
  if (re('(?:bold|bd)$')) return 'bold';
  if (re(`(?:${base})?(?:italic|it)$`)) return 'italic';
  if (re('(?:regular|roman|book|rg|text)$')) return 'regular';
  return null;
}

// [style, file] pairs, in the canonical order, for the faces of `family` the
// folder ships. Of faces that spell a style differently, the plain one wins
// (-Italic over -TextItalic); the base face is -Regular when there is one.
function stylesOf(files, family, extra) {
  const styles = STYLES_LOWER.map((style) => {
    const found = files.filter((file) => FONT_RE.test(file)
      && styleOf(file.replace(FONT_RE, '').replace(STAMP_RE, ''), family) === style)
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
    return [style, (files.includes(extra[style]) && extra[style])
      || (style === 'regular' && found.find((f) => /[-_ ]regular\./i.test(f))) || found[0]];
  });
  return styles.filter(([, file]) => file);
}

// The families a folder holds: one per stem with a base face. Without a
// -Regular face, a bare stem is one only if no named family contains it.
function familiesOf(files, extra = {}) {
  const stems = files.filter((f) => FONT_RE.test(f)).map((f) => f.replace(FONT_RE, '').replace(STAMP_RE, ''));
  const named = stems.map((s) => (s.match(BASE_RE) || [])[1]).filter(Boolean).map(trim);
  const bare = stems.filter((s) => !STYLED_RE.test(s) && !OTHER_WEIGHT_RE.test(s) && !named.some((n) => s.startsWith(n)));
  return [...new Set([...named, ...bare])].map((stem) => ({ stem, styles: stylesOf(files, stem, extra) }));
}

// What an entry declares and upstream still has, in the same shape.
const declaredStyles = (fam, files) => STYLES
  .map((style) => [style.toLowerCase(), sourceFile(fam, style)])
  .filter(([, file]) => files.includes(file));
const spelled = (styles) => styles.map(([style]) => style).join(', ');

// ---- main ------------------------------------------------------------------

const config = JSON.parse(await readFile(join(ROOT, 'families.json'), 'utf8'));
const shas = fetchTree(config.upstream, config.upstreamRef);
const folders = new Map(); // 'Modified Fonts/<folder>' -> [files]
for (const path of shas.keys()) {
  const m = path.match(/^(Modified Fonts|Unmodified Fonts)\/([^/]+)\/([^/]+)$/);
  if (!m) continue;
  const source = `${m[1]}/${m[2]}`;
  if (!folders.has(source)) folders.set(source, []);
  folders.get(source).push(m[3]);
}

const bySource = new Map();
for (const fam of config.families) {
  if (!bySource.has(fam.source)) bySource.set(fam.source, []);
  bySource.get(fam.source).push(fam);
}
const known = new Set(config.families.map((f) => f.name));
const fresh = [], restyled = [], skipped = [], read = new Set();
for (const [source, files] of [...folders].sort()) {
  const [category, folder] = source.split('/');
  const over = OVERRIDES[source] || {};
  const families = familiesOf(files, over.files);
  if (!families.length) { skipped.push(`${source} (no Regular face)`); continue; }
  const licenseFile = [...files].sort().find((f) => LICENSE_RE.test(f));
  const licenseUrl = over.licenseUrl;
  if (!licenseFile && !licenseUrl) { skipped.push(`${source} (no license file)`); continue; }

  for (const { stem, styles } of families) {
    // An entry is this family when its Regular face is the folder's.
    const entry = (bySource.get(source) || []).find((f) => sourceFile(f, 'Regular') === styles[0][1]);
    if (entry) {
      read.add(entry);
      const before = declaredStyles(entry, files);
      if (JSON.stringify(before) !== JSON.stringify(styles)) {
        restyled.push(`${entry.name}: ${spelled(styles)} (was ${spelled(before) || 'none'})`);
        entry.files = Object.fromEntries(styles);
      }
      continue;
    }
    const name = over.name || stem.replace(/ /g, '');
    if (!/^[A-Za-z0-9_-]+$/.test(name)) { skipped.push(`${source} (bad name "${name}")`); continue; }
    if (known.has(name)) { skipped.push(`${source} ("${name}" is already another family: name it in OVERRIDES)`); continue; }
    known.add(name);
    fresh.push({
      name,
      source,
      // A folder name upstream may end in a space ("M PLUS Code Latin ").
      title: (over.title || (category === 'Modified Fonts' ? folder.split(' - ')[0] : folder)).trim(),
      description: '',
      license: licenseUrl || OFL_BY_NAME_RE.test(licenseFile) ? 'OFL' : 'see license file',
      licenseFile: licenseFile || 'OFL.txt',
      ...(licenseUrl ? { licenseUrl, $licenseNote: `WP-Fonts ships no license file for this folder; the license text is carried from ${licenseUrl}.` } : {}),
      files: Object.fromEntries(styles),
    });
  }
}

// A vanished family stays in the catalog for its users, but it cannot be
// built again: families.json has to say so, not hide it.
const stale = config.families.filter((f) => !folders.has(f.source));
const broken = config.families.filter((f) => folders.has(f.source)
  && !folders.get(f.source).includes(sourceFile(f, 'Regular')));
// An entry whose Regular face the rules do not recognise as one is left as
// declared — but its styles are then not being kept in step.
const unread = config.families.filter((f) => !read.has(f) && !stale.includes(f) && !broken.includes(f));

console.log(`upstream ${config.upstream}@${config.upstreamRef}: ${folders.size} folders; families.json declares ${config.families.length} families`);
console.log(`new families: ${fresh.length}`);
for (const f of fresh) {
  console.log(`  + ${f.name}  "${f.title}"  [${Object.keys(f.files).join(', ')}]  ${f.licenseFile}${f.licenseUrl ? ' (license elsewhere)' : ''}`);
}
console.log(`families whose styles upstream changed: ${restyled.length}`);
for (const r of restyled) console.log(`  ~ ${r}`);
console.log(`skipped folders: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s}`);
console.log(`entries no longer backed upstream: ${stale.length + broken.length}`);
for (const f of stale) console.log(`  STALE  ${f.name} -> ${f.source}${PRUNE ? '  (dropped)' : ''}`);
for (const f of broken) console.log(`  BROKEN ${f.name}: ${sourceFile(f, 'Regular')} is not in ${f.source}`);
console.log(`existing families found as declared: ${read.size - restyled.length}, not recognised by the rules: ${unread.length}`);
for (const f of unread) console.log(`  UNREAD ${f.name}: ${sourceFile(f, 'Regular')} is not a Regular face for these rules`);

if (!DRY) {
  config.families = config.families.filter((f) => !(PRUNE && stale.includes(f)));
  config.families = [...config.families, ...fresh];
  if (fresh.length || restyled.length || (PRUNE && stale.length)) {
    await writeFile(join(ROOT, 'families.json'), JSON.stringify(config, null, 2) + '\n');
    console.log(`families.json now has ${config.families.length} families`);
  } else {
    console.log('families.json unchanged');
  }
}
// Left for a human decision, these must not pass as a clean resync.
process.exitCode = stale.length + broken.length ? 1 : 0;
