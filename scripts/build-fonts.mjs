#!/usr/bin/env node
// Build precompiled .cpfont families for CrossPoint readers (Xteink X4 Pro)
// from the curated allowlist in families.json.
//
// Pipeline: download TTF/OTF from WP-Fonts -> crossglyph workspace + conf ->
// crossglyph build (incremental) -> preview PNGs -> catalog/fonts.json with
// size+crc32 per file -> dist/assets/ staged for the rolling GitHub release.
//
// Usage:
//   node scripts/build-fonts.mjs [--base-url URL] [--raw-base URL]
//       [--force-download] [--skip-build] [--jobs N]
//
//   --base-url  release asset URL prefix written into the catalog
//               (default: placeholder OWNER — CI passes the real one)
//   --raw-base  raw.githubusercontent prefix for previews/licenses links
//   --jobs      parallel rasterization jobs (default: CPU count)
//
// CrossGlyph itself (pinned in CROSSGLYPH_VERSION) is downloaded into tools/
// on first run; keep tools/ and workspace/ cached in CI to stay incremental.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CROSSGLYPH_VERSION = '0.9.1';
const CROSSGLYPH_ZIP_URL =
  `https://github.com/CrazyCoder/crossglyph/releases/download/v${CROSSGLYPH_VERSION}/crossglyph-${CROSSGLYPH_VERSION}.zip`;
const STYLES = ['Regular', 'Bold', 'Italic', 'BoldItalic'];

// ---- args -----------------------------------------------------------------

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const OPTS = {
  baseUrl: arg('--base-url', 'https://github.com/OWNER/cp-fonts/releases/download/fonts/'),
  rawBase: arg('--raw-base', 'https://raw.githubusercontent.com/OWNER/cp-fonts/main/'),
  jobs: Number(arg('--jobs', String(cpus().length))),
  forceDownload: process.argv.includes('--force-download'),
  skipBuild: process.argv.includes('--skip-build'),
  catalogOnly: process.argv.includes('--catalog-only'),
};

// ---- presentation metadata (catalog-time, not build input) ---------------

// Hand-tuned exceptions to the name heuristic; everything else falls back to
// Serif, which is what a reading-font collection skews to anyway.
const GROUP_OVERRIDES = {
  WPBittersweet: 'Slab',      // Bitter
  WPSpikes: 'Mono',           // Agave
  WPFourChan: 'Mono',         // Anonymous Pro
  WPRedDye: 'Serif',          // Cochineal
  WPKornut: 'Serif',
  WPBeholderBook: 'Serif',
};
function familyGroup(fam) {
  if (GROUP_OVERRIDES[fam.name]) return GROUP_OVERRIDES[fam.name];
  const hay = fam.name + ' ' + (fam.title || '');
  if (/\b(mono|code|console|term)\b/i.test(hay)) return 'Mono';
  if (/slab/i.test(hay)) return 'Slab';
  if (/\bsans\b|(^|[^a-z])gothic/i.test(hay)) return 'Sans';
  return 'Serif';
}

// Classify a license file by its content — the file is the source of truth,
// the filename is not (WP-Fonts ships OFL text under several names).
const LICENSE_SIGNATURES = [
  [/SIL OPEN FONT LICENSE/i, 'OFL'],
  [/GNU GENERAL PUBLIC LICENSE/i, 'GPL'],
  [/APACHE LICENSE/i, 'Apache-2.0'],
  [/REDISTRIBUTION AND USE IN SOURCE/i, 'BSD'],
  [/(MIT LICEN[CS]E|Permission is hereby granted, free of charge)/i, 'MIT'],
  [/CC0|PUBLIC DOMAIN/i, 'CC0/PD'],
  [/M\+ FONTS? LICEN[CS]E/i, 'M+'],
  [/UBUNTU FONT LICEN[CS]E/i, 'UFL'],
  [/IPA FONT LICEN[CS]E/i, 'IPA'],
];
function classifyLicense(text) {
  if (!text) return null;
  for (const [re, name] of LICENSE_SIGNATURES) if (re.test(text)) return name;
  return null;
}

// ---- crc32 (no dependencies) ----------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- helpers ---------------------------------------------------------------

const log = (msg) => console.log(msg);
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function fetchBin(url, dest) {
  // Prefer native fetch; some environments (proxied Windows shells) only let
  // curl through, so fall back to it on any connection error.
  let bytes;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    bytes = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    const result = spawnSync('curl', ['-sfL', '--retry', '3', '-o', dest, url]);
    if (result.status !== 0) throw new Error(`download failed via curl (${result.status}) ${url}`);
    bytes = await readFile(dest);
    return bytes;
  }
  await writeFile(dest, bytes);
  return bytes;
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function runCrossglyph(args) {
  const dir = join(ROOT, 'tools', 'crossglyph', `crossglyph-${CROSSGLYPH_VERSION}`);
  const env = { ...process.env, CI: '1' };
  // Warnings fail the build only when asked: with hundreds of families a
  // single odd font must not sink the whole batch.
  if (process.env.CROSSGLYPH_STRICT && args[0] === 'build') args = [...args, '--fail-on-warning'];
  const result = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', 'crossglyph.cmd', '--no-update-check', ...args], { cwd: dir, env, stdio: 'inherit' })
    : spawnSync('sh', ['crossglyph.sh', '--no-update-check', ...args], { cwd: dir, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`crossglyph ${args[0]} exited ${result.status}`);
}

// ---- steps -----------------------------------------------------------------

async function ensureCrossglyph() {
  const dir = join(ROOT, 'tools', 'crossglyph', `crossglyph-${CROSSGLYPH_VERSION}`);
  if (process.platform === 'win32') {
    if (existsSync(join(dir, 'crossglyph.cmd'))) return;
  } else if (existsSync(join(dir, 'crossglyph.sh'))) return;

  log(`Downloading CrossGlyph ${CROSSGLYPH_VERSION}…`);
  await mkdir(join(ROOT, 'tools'), { recursive: true });
  const zip = join(ROOT, 'tools', `crossglyph-${CROSSGLYPH_VERSION}.zip`);
  await fetchBin(CROSSGLYPH_ZIP_URL, zip);
  execFileSync('unzip', ['-q', '-o', zip, '-d', join(ROOT, 'tools', 'crossglyph')], { stdio: 'inherit' });
  log('CrossGlyph ready.');
}

async function fetchSources(config) {
  const raw = `https://raw.githubusercontent.com/${config.upstream}/${config.upstreamRef}/`;
  const summary = [];
  for (const fam of config.families) {
    const famDir = join(ROOT, 'workspace', 'fonts', fam.name);
    await mkdir(famDir, { recursive: true });
    const styles = [];
    for (const style of STYLES) {
      // families.json may map styles to exact upstream filenames (OTF
      // extensions, TeX-style -Roman base faces); the local copy always uses
      // the standard <Name>-<Style> stem so crossglyph resolves the family.
      const src = (fam.files && fam.files[style.toLowerCase()]) || `${fam.name}-${style}.ttf`;
      const ext = src.toLowerCase().endsWith('.otf') ? 'otf' : 'ttf';
      const local = `${fam.name}-${style}.${ext}`;
      const file = join(famDir, local);
      if (!OPTS.forceDownload && await exists(file)) { styles.push(style); continue; }
      const url = `${raw}${encPath(fam.source)}/${encPath(src)}`;
      try {
        await fetchBin(url, file);
        styles.push(style);
      } catch (e) {
        if (style === 'Regular') throw new Error(`family ${fam.name}: no Regular face (${e.message})`);
        log(`  note: ${fam.name} has no ${style} face`);
      }
    }
    if (fam.licenseFile) {
      const licDest = join(ROOT, 'licenses', `${fam.name}-${fam.licenseFile}`);
      if (OPTS.forceDownload || !(await exists(licDest))) {
        await mkdir(join(ROOT, 'licenses'), { recursive: true });
        // licenseUrl overrides the WP-Fonts folder (for families whose
        // upstream folder ships no license file).
        const licUrl = fam.licenseUrl || `${raw}${encPath(fam.source)}/${encPath(fam.licenseFile)}`;
        await fetchBin(licUrl, licDest);
      }
    }
    summary.push({ fam, styles });
    log(`  ${fam.name}: ${styles.join(', ')}`);
  }
  return summary;
}

async function writeConf(config) {
  const confDir = join(ROOT, 'workspace', 'fonts', 'conf');
  await mkdir(confDir, { recursive: true });
  await writeFile(join(confDir, 'all.conf'),
    `# Generated by scripts/build-fonts.mjs — edit families.json instead.\n` +
    `sizes = ${config.sizes.join(' ')}\n` +
    `intervals = ${config.intervals}\n`);
}

function ptFromName(name) {
  const m = name.match(/^(.*)[-_](\d+)\.cpfont$/i);
  if (!m) throw new Error(`cannot parse point size from ${name}`);
  return Number(m[2]);
}

async function collectOutputs(config, sources) {
  const cpfonts = join(ROOT, 'workspace', 'fonts', 'cpfonts');
  const assetsDir = join(ROOT, 'dist', 'assets');
  await mkdir(assetsDir, { recursive: true });
  await mkdir(join(ROOT, 'dist', 'catalog'), { recursive: true });
  await mkdir(join(ROOT, 'catalog'), { recursive: true });

  const families = [];
  // In catalog-only runs families without local build output keep their
  // previous catalog entry (files/previews), refreshed with the presentation
  // fields — so regenerating metadata never shrinks the catalog.
  let previous = null;
  if (OPTS.catalogOnly) {
    try {
      previous = new Map(JSON.parse(await readFile(join(ROOT, 'catalog', 'fonts.json'), 'utf8')).families.map((f) => [f.name, f]));
    } catch (e) { /* no previous catalog */ }
  }
  for (const { fam, styles } of sources) {
    const files = [];
    const famOut = join(cpfonts, fam.name);
    if (await exists(famOut)) {
      for (const name of (await readdir(famOut)).filter((f) => f.endsWith('.cpfont'))) {
        const bytes = await readFile(join(famOut, name));
        await copyFile(join(famOut, name), join(assetsDir, name));
        files.push({ name, pt: ptFromName(name), size: bytes.length, crc32: crc32(bytes) });
      }
    }
    // License: read the actual file and classify by content; link it raw.
    let license = fam.license || '';
    let licenseUrl = null;
    if (fam.licenseFile) {
      const licPath = join(ROOT, 'licenses', `${fam.name}-${fam.licenseFile}`);
      try {
        const byName = classifyLicense(await readFile(licPath, 'utf8'));
        if (byName) license = byName;
        else if (license === 'see license file') license = 'Other';
        licenseUrl = OPTS.rawBase.replace(/\/*$/, '/') + `licenses/${fam.name}-${fam.licenseFile}`;
      } catch (e) { /* license not fetched locally — keep families.json value */ }
    }
    const presentation = { group: familyGroup(fam), license, licenseUrl };

    if (!files.length) {
      const old = previous && previous.get(fam.name);
      if (old) {
        log(`  kept previous entry for ${fam.name} (no local output)`);
        families.push({ ...old, ...presentation, licensePath: old.licensePath || null });
      } else {
        log(`  SKIPPED ${fam.name}: no .cpfont output`);
      }
      continue;
    }
    files.sort((a, b) => a.pt - b.pt);

    const previews = config.previewSizes
      .filter((pt) => existsSync(join(ROOT, 'previews', `${fam.name}-${pt}.png`)))
      .map((pt) => ({ pt, path: `previews/${fam.name}-${pt}.png` }));

    families.push({
      name: fam.name,
      title: fam.title,
      description: fam.description,
      group: familyGroup(fam),
      license,
      licenseUrl,
      licensePath: fam.licenseFile ? `licenses/${fam.name}-${fam.licenseFile}` : null,
      source: `${config.upstream} (${fam.source})`,
      styles: styles.map((s) => s.toLowerCase()),
      sizes: files.map((f) => f.pt),
      files,
      previews,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
    });
    log(`  ${fam.name}: ${files.length} sizes, ${families.at(-1).totalBytes} bytes`);
  }

  const catalog = {
    version: 1,
    updated: new Date().toISOString().slice(0, 10),
    generator: `cp-fonts build-fonts.mjs (crossglyph ${CROSSGLYPH_VERSION})`,
    baseUrl: OPTS.baseUrl.replace(/\/*$/, '/'),
    rawBase: OPTS.rawBase.replace(/\/*$/, '/'),
    device: config.device,
    families,
  };
  await writeFile(join(ROOT, 'catalog', 'fonts.json'), JSON.stringify(catalog, null, 2) + '\n');
  await writeFile(join(ROOT, 'dist', 'catalog', 'fonts.json'), JSON.stringify(catalog) + '\n');
}

// ---- main ------------------------------------------------------------------

const config = JSON.parse(await readFile(join(ROOT, 'families.json'), 'utf8'));
const catalogOnly = OPTS.catalogOnly;
log('1/5 CrossGlyph…');
if (!catalogOnly) await ensureCrossglyph();
log('2/5 sources…');
const sources = await fetchSources(config);
log('3/5 build…');
const failedFamilies = [];
if (!catalogOnly && !OPTS.skipBuild) {
  await writeConf(config);
  const buildArgs = ['build',
    '--fonts', join(ROOT, 'workspace', 'fonts'),
    '--out', join(ROOT, 'workspace', 'fonts', 'cpfonts'),
    '-j', String(OPTS.jobs)];
  try {
    runCrossglyph(buildArgs);
  } catch (e) {
    // Some sources cannot cover the reading set (symbol/barcode faces) and
    // make the batch build exit nonzero after everything else succeeded.
    // Isolate them per family so one odd font never sinks the run.
    log(`  full build failed (${e.message}); retrying family by family…`);
    for (const { fam } of sources) {
      try {
        runCrossglyph([...buildArgs, fam.name]);
      } catch (e2) {
        failedFamilies.push(fam.name);
        log(`  SKIPPED ${fam.name}: ${e2.message}`);
      }
    }
  }
}
log('4/5 previews…');
if (!catalogOnly) {
  await mkdir(join(ROOT, 'previews'), { recursive: true });
  for (const { fam } of sources) {
    if (failedFamilies.includes(fam.name)) continue;
    for (const pt of config.previewSizes) {
      try {
        runCrossglyph(['preview', '--family', fam.name, '--size', String(pt),
          '--device', config.device, '--fonts', join(ROOT, 'workspace', 'fonts'),
          '--png', join(ROOT, 'previews', `${fam.name}-${pt}.png`)]);
      } catch (e) {
        log(`  SKIPPED preview ${fam.name}@${pt}: ${e.message}`);
      }
    }
  }
}
log('5/5 catalog…');
await collectOutputs(config, sources);
log(`Done: catalog/fonts.json (${config.families.length - failedFamilies.length}/${config.families.length} families), dist/assets/ staged, previews/ updated.` +
  (failedFamilies.length ? ` Skipped (unbuildable): ${failedFamilies.join(', ')}` : ''));
