#!/usr/bin/env node
// Build precompiled .cpfont families for CrossPoint readers (Xteink X4 Pro)
// from the curated allowlist in families.json — incrementally.
//
// A family is fingerprinted by its inputs: source files and license (by git
// blob sha, read from the upstream tree without downloading it), sizes and
// CrossGlyph version. A family whose fingerprint is unchanged and whose files
// are still published is left alone: not downloaded, not built, not previewed.
// Only what changed goes through the pipeline
//
//   download TTF/OTF -> crossglyph build -> check for blank glyphs -> preview PNGs
//   -> catalog/fonts.json
//
// and only those binaries are handed to scripts/publish-binaries.mjs. The
// record of what was built from what is catalog/build-state.json; the run's
// outcome is dist/build-report.json (`--report` turns it into an exit status).
//
// A family's `hinting` in families.json (normal, light, none, auto) is part of
// what it is built with: it becomes a conf of its own for CrossGlyph, and a
// change to it rebuilds the family.
//
// Usage:
//   node scripts/build-fonts.mjs [--base-url URL] [--raw-base URL]
//       [--jobs N] [--only name,name] [--force] [--catalog-only]
//   node scripts/build-fonts.mjs --report
//
//   --base-url    URL prefix of the published .cpfont files, written into
//                 the catalog (default: what the catalog already carries;
//                 CI passes the real one)
//   --raw-base    raw.githubusercontent prefix for previews/licenses links
//   --jobs        parallel download and preview jobs (default: CPU count)
//   --only        build just these families; leave every other one alone
//   --force       rebuild everything (new CrossGlyph, new sizes, migration)
//   --catalog-only  refresh descriptions, titles and licenses in the catalog
//                 from families.json, without building or touching the state

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankGlyphs, isUnusable, readCpfont } from './lib/cpfont.mjs';
import { fetchTree } from './lib/github-tree.mjs';
import { classifyLicense } from './lib/license.mjs';
import { carriedOver, HINTING_MODES, isNewProblem, planBuild, sourceFile, STYLES } from './lib/plan.mjs';
import { fetchPublished } from './lib/published.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CROSSGLYPH_VERSION = '0.9.1';
const CROSSGLYPH_ZIP_URL =
  `https://github.com/CrazyCoder/crossglyph/releases/download/v${CROSSGLYPH_VERSION}/crossglyph-${CROSSGLYPH_VERSION}.zip`;
// Every family is built with the bytes of that zip: a release uploaded again
// must not pass for the tool the families were verified with.
const CROSSGLYPH_ZIP_SHA256 = '9ac7e76d1b9a04342bdaf11551bbfb569b5a02b89b80b7897a6208b0a71f5615';
const CATALOG = join(ROOT, 'catalog', 'fonts.json');
const STATE = join(ROOT, 'catalog', 'build-state.json');
const DIST = join(ROOT, 'dist');
const CPFONTS = join(ROOT, 'workspace', 'fonts', 'cpfonts');

// ---- args -----------------------------------------------------------------

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const OPTS = {
  baseUrl: arg('--base-url'),
  rawBase: arg('--raw-base'),
  jobs: Number(arg('--jobs', String(cpus().length))),
  only: arg('--only') ? new Set(arg('--only').split(',').map((s) => s.trim()).filter(Boolean)) : null,
  force: process.argv.includes('--force'),
  catalogOnly: process.argv.includes('--catalog-only'),
  report: process.argv.includes('--report'),
};

// ---- presentation metadata (catalog-time, not build input) ---------------

// Functional grouping, read from the font binary itself: the `post` table's
// isFixedPitch flags monospaced faces, and OS/2's PANOSE bytes classify the
// family the way the type designer intended (text vs script vs decorative,
// serifed vs sans). Name heuristics are only the fallback.
function readFontMeta(file) {
  try {
    const b = readFileSync(file);
    const u16 = (o) => b.readUInt16BE(o);
    const u32 = (o) => b.readUInt32BE(o);
    const numTables = u16(4);
    let post = -1, os2 = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + 16 * i;
      const tag = b.toString('latin1', rec, rec + 4);
      if (tag === 'post') post = u32(rec + 8);
      else if (tag === 'OS/2') os2 = u32(rec + 8);
    }
    const meta = { fixedPitch: false, panose: null };
    if (post >= 0 && post + 16 <= b.length) meta.fixedPitch = u32(post + 12) !== 0;
    // sFamilyClass at 30, PANOSE (10 bytes) at 32 — present in OS/2 v0+.
    if (os2 >= 0 && os2 + 42 <= b.length) {
      meta.panose = [...b.slice(os2 + 32, os2 + 42)];
      meta.familyClass = b.readInt16BE(os2 + 30);
    }
    return meta;
  } catch (e) { return null; }
}

function familyGroup(fam) {
  const hay = fam.name + ' ' + (fam.title || '');
  const dir = join(ROOT, 'workspace', 'fonts', fam.name);
  const reg = existsSync(join(dir, `${fam.name}-Regular.ttf`)) ? join(dir, `${fam.name}-Regular.ttf`)
    : existsSync(join(dir, `${fam.name}-Regular.otf`)) ? join(dir, `${fam.name}-Regular.otf`) : null;
  const meta = reg && readFontMeta(reg);

  if (meta) {
    if (meta.fixedPitch) return 'Mono';
    const kind = meta.panose ? meta.panose[0] : 0;
    if (kind === 3) return 'Script';
    if (kind === 4 || kind === 5) return 'Display';
    if (/\b(display|titling|poster)\b/i.test(hay)) return 'Display';
    // PANOSE serif style: 0 any, 1 no-fit, 2-10 serifed, 11-15 sans/flared.
    const serifStyle = meta.panose ? meta.panose[1] : 0;
    if (serifStyle >= 11 && serifStyle <= 14) return 'Interface';
    return 'Reading';
  }
  // Fallback when the binary is not around (families that were not rebuilt).
  if (/\b(mono|code|console|term)\b/i.test(hay)) return 'Mono';
  if (/\b(script|hand|callig)\w*/i.test(hay)) return 'Script';
  if (/\b(display|titling|poster)\b/i.test(hay)) return 'Display';
  if (/\bsans\b|(^|[^a-z])gothic/i.test(hay)) return 'Interface';
  return 'Reading';
}

// ---- helpers ---------------------------------------------------------------

const log = (msg) => console.log(msg);
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const today = () => new Date().toISOString().slice(0, 10);

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function readJsonOrNull(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

// Git's blob id of a file's bytes: what the `fonts` ref records, so a later
// run can tell the published binary is the one this state was built into.
function blobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// Run `worker` over `items`, at most `limit` at a time.
async function mapLimit(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

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

// ---- CrossGlyph ------------------------------------------------------------

const crossglyphDir = () => join(ROOT, 'tools', 'crossglyph', `crossglyph-${CROSSGLYPH_VERSION}`);

async function ensureCrossglyph() {
  const dir = crossglyphDir();
  if (process.platform === 'win32') {
    if (existsSync(join(dir, 'crossglyph.cmd'))) return;
  } else if (existsSync(join(dir, 'crossglyph.sh'))) return;

  log(`Downloading CrossGlyph ${CROSSGLYPH_VERSION}…`);
  await mkdir(join(ROOT, 'tools'), { recursive: true });
  const zip = join(ROOT, 'tools', `crossglyph-${CROSSGLYPH_VERSION}.zip`);
  const bytes = await fetchBin(CROSSGLYPH_ZIP_URL, zip);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== CROSSGLYPH_ZIP_SHA256) {
    await rm(zip, { force: true });
    throw new Error(`CrossGlyph ${CROSSGLYPH_VERSION} is not the build it was checked with (sha256 ${digest}, `
      + `expected ${CROSSGLYPH_ZIP_SHA256}): not unpacked, nothing built`);
  }
  try {
    execFileSync('unzip', ['-q', '-o', zip, '-d', join(ROOT, 'tools', 'crossglyph')], { stdio: 'inherit' });
  } catch (e) {
    throw new Error(`cannot unpack CrossGlyph: ${e.code === 'ENOENT' ? 'unzip is not installed' : e.message}`);
  } finally {
    await rm(zip, { force: true }); // what is kept is the unpacked tool
  }
  log('CrossGlyph ready.');
}

// Resolves { code, lastLine }: the line that says why a run failed, if it
// did. Both streams are kept apart — interleaved they scramble — and the
// tool goes on printing progress ("Rasterizing...") after the error line,
// while the Windows wrapper ends with a "press any key" prompt.
function runTool(cmd, cmdArgs) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, cmdArgs, { cwd: crossglyphDir(), env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const tails = { stdout: '', stderr: '' };
    const grab = (stream) => (chunk) => { tails[stream] = (tails[stream] + chunk.toString()).slice(-2000); };
    child.stdout.on('data', grab('stdout'));
    child.stderr.on('data', grab('stderr'));
    const lastSaying = (text, re) => said(text).filter((l) => re.test(l)).pop();
    const lastSaid = (text) => said(text).pop();
    child.on('error', (e) => resolveRun({ code: -1, lastLine: e.message }));
    child.on('close', (code) => {
      const { stdout, stderr } = tails;
      const line = lastSaying(stderr, /FAILED|error/i) || lastSaying(stdout, /FAILED|error/i)
        || lastSaid(stderr) || lastSaid(stdout) || `exited ${code}`;
      // "<Family> <size> FAILED after 0s: <reason>" — the reason is what matters.
      resolveRun({ code, lastLine: line.replace(/^\S+ \d+ FAILED after [^:]+: /, '') });
    });
  });
}

function runCrossglyph(args) {
  const [cmd, cmdArgs] = process.platform === 'win32'
    ? ['cmd', ['/c', 'crossglyph.cmd', '--no-update-check', ...args]]
    : ['sh', ['crossglyph.sh', '--no-update-check', ...args]];
  return runTool(cmd, cmdArgs);
}

// Python inside CrossGlyph's own environment, started the way its launcher
// starts the tool: the uv bundled with it, on its project. For what the
// command line cannot do.
function runCrossglyphPython(args) {
  const project = join('versions', CROSSGLYPH_VERSION);
  const uvArgs = ['run', '--project', project, 'python', '-I', '-X', 'utf8', ...args];
  const [cmd, cmdArgs] = process.platform === 'win32'
    ? ['cmd', ['/c', join(project, 'tools', 'uv.cmd'), ...uvArgs]]
    : [join(project, 'tools', 'uv.cmd'), uvArgs];
  return runTool(cmd, cmdArgs);
}

function said(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !/press any key|presione una tecla/i.test(l));
}

// ---- steps -----------------------------------------------------------------

// Downloads what the families to build need, starting from a clean folder so
// an earlier copy can never leak into the new build. A family without a
// Regular face is reported, not thrown: it must not sink the other families.
async function fetchSources(config, families) {
  const raw = `https://raw.githubusercontent.com/${config.upstream}/${config.upstreamRef}/`;
  const summary = [];
  await mapLimit(families, OPTS.jobs, async (fam) => {
    const famDir = join(ROOT, 'workspace', 'fonts', fam.name);
    await rm(famDir, { recursive: true, force: true });
    await rm(join(CPFONTS, fam.name), { recursive: true, force: true });
    await mkdir(famDir, { recursive: true });
    const styles = [];
    let error = null;
    for (const style of STYLES) {
      // families.json may map styles to exact upstream filenames (OTF
      // extensions, TeX-style -Roman base faces); the local copy always uses
      // the standard <Name>-<Style> stem so crossglyph resolves the family.
      const src = sourceFile(fam, style);
      const local = `${fam.name}-${style}.${src.toLowerCase().endsWith('.otf') ? 'otf' : 'ttf'}`;
      try {
        await fetchBin(`${raw}${encPath(fam.source)}/${encPath(src)}`, join(famDir, local));
        styles.push(style);
      } catch (e) {
        if (style === 'Regular') { error = `no Regular face upstream (${e.message})`; break; }
      }
    }
    if (!error && fam.licenseFile) {
      try {
        await mkdir(join(ROOT, 'licenses'), { recursive: true });
        // licenseUrl overrides the WP-Fonts folder (for families whose
        // upstream folder ships no license file).
        const licUrl = fam.licenseUrl || `${raw}${encPath(fam.source)}/${encPath(fam.licenseFile)}`;
        await fetchBin(licUrl, join(ROOT, 'licenses', `${fam.name}-${fam.licenseFile}`));
      } catch (e) { log(`  note: ${fam.name}: license file not fetched (${e.message})`); }
    }
    summary.push({ fam, styles, error });
    log(`  ${fam.name}: ${error ? 'FAILED: ' + error : styles.join(', ')}`);
  });
  return summary;
}

// `all.conf` holds what every family shares. A family with a `hinting` of its
// own gets a conf that inherits from it and overrides that one key — for a
// font whose instructions make CrossGlyph's default hinting collapse its
// outlines. One that no longer needs it loses the file.
async function writeConf(config) {
  const confDir = join(ROOT, 'workspace', 'fonts', 'conf');
  await mkdir(confDir, { recursive: true });
  const note = '# Generated by scripts/build-fonts.mjs — edit families.json instead.\n';
  await writeFile(join(confDir, 'all.conf'),
    note +
    `sizes = ${config.sizes.join(' ')}\n` +
    `intervals = ${config.intervals}\n`);
  for (const fam of config.families) {
    const file = join(confDir, `${fam.name}.conf`);
    if (fam.hinting) await writeFile(file, `${note}hinting = ${fam.hinting}\n`);
    else await rm(file, { force: true });
  }
}

function ptFromName(name) {
  const m = name.match(/^(.*)[-_](\d+)\.cpfont$/i);
  if (!m) throw new Error(`cannot parse point size from ${name}`);
  return Number(m[2]);
}

// True when the family has a fresh output file for every configured size.
function hasCompleteOutput(config, name) {
  return config.sizes.every((pt) => existsSync(join(CPFONTS, name, `${name}_${pt}.cpfont`)));
}

async function buildFamilies(config, sources, failed) {
  if (!sources.length) return;
  await ensureCrossglyph();
  await writeConf(config);
  const buildArgs = ['build', '--force',
    '--fonts', join(ROOT, 'workspace', 'fonts'),
    '--out', CPFONTS,
    '-j', String(OPTS.jobs)];
  const names = sources.map((s) => s.fam.name);

  // One invocation builds the whole batch; --force keeps a stale crossglyph
  // cache in a local workspace from passing an old rasterization off as new.
  let pending = names;
  const oneInvocation = names.length > 1 &&
    (process.platform !== 'win32' || names.join(' ').length < 6000); // cmd.exe command line limit
  if (oneInvocation) {
    const { code } = await runCrossglyph([...buildArgs, ...names]);
    if (code !== 0) log(`  batch build exited ${code}; isolating the families it could not build`);
    pending = names.filter((name) => !hasCompleteOutput(config, name));
    if (code !== 0 && !pending.length) pending = names;
  }
  // Some sources cannot cover the reading set (symbol/barcode faces) and make
  // the batch exit nonzero after everything else succeeded. Retry the rest on
  // its own so one odd font never sinks the run — and is reported by name.
  for (const name of pending) {
    const { code, lastLine } = await runCrossglyph([...buildArgs, name]);
    if (code !== 0 || !hasCompleteOutput(config, name)) {
      failed.set(name, `crossglyph build: ${lastLine}`);
      log(`  SKIPPED ${name}: ${lastLine}`);
    }
  }
}

// A build can succeed and still be unusable. Some fonts carry TrueType
// instructions that make FreeType's native hinting collapse an outline, and
// the converter writes what it is handed: WPGalatians' bold was published with
// a third of its letters as gaps. What a family drew is checked here, before
// anything of it is previewed or published.
async function checkGlyphs(sources, failed) {
  for (const { fam } of sources) {
    if (failed.has(fam.name)) continue;
    const dir = join(CPFONTS, fam.name);
    for (const name of (await readdir(dir)).filter((f) => f.endsWith('.cpfont')).sort()) {
      const cpfont = readCpfont(await readFile(join(dir, name)));
      if (!cpfont) failed.set(fam.name, `${name} is not a .cpfont v4 file`);
      else {
        const blank = blankGlyphs(cpfont).filter(isUnusable);
        if (!blank.length) continue;
        failed.set(fam.name, `blank glyphs in ${name}: ` + blank
          .map((b) => `${b.style} ${b.chars.slice(0, 24).map((cp) => String.fromCodePoint(cp)).join('')}… (${b.chars.length} letters)`)
          .join('; '));
      }
      log(`  SKIPPED ${fam.name}: ${failed.get(fam.name)}`);
      break;
    }
  }
}

// Each preview is one crossglyph start (about 13 s on CI), which is what made
// a full rebuild take two hours; only families built in this run are rendered,
// several at a time.
async function renderPreviews(config, sources) {
  const jobs = sources.flatMap(({ fam }) => config.previewSizes.map((pt) => ({ fam, pt })));
  if (!jobs.length) return;
  await ensureCrossglyph();
  await mkdir(join(ROOT, 'previews'), { recursive: true });
  let done = 0;
  await mapLimit(jobs, OPTS.jobs, async ({ fam, pt }) => {
    const png = join(ROOT, 'previews', `${fam.name}-${pt}.png`);
    // `crossglyph preview --png` draws every family with the default settings,
    // so one built with a `hinting` of its own goes through preview-page.py,
    // which gives it the settings it was built with.
    const { code, lastLine } = fam.hinting
      ? await runCrossglyphPython([join(ROOT, 'scripts', 'preview-page.py'), join(ROOT, 'workspace', 'fonts'),
        fam.name, String(pt), config.device, png])
      : await runCrossglyph(['preview', '--family', fam.name, '--size', String(pt),
        '--device', config.device, '--fonts', join(ROOT, 'workspace', 'fonts'), '--png', png]);
    done++;
    if (code !== 0) log(`  SKIPPED preview ${fam.name}@${pt}: ${lastLine}`);
    if (done % 50 === 0 || done === jobs.length) log(`  previews: ${done}/${jobs.length}`);
  });
}

// ---- catalog, state and report ---------------------------------------------

// What the catalog says of a family's license: the file shipped with the
// binaries, classified by its text. What families.json asserts only stands
// when there is no file to read.
async function licenseOf(fam) {
  try {
    const path = `licenses/${fam.name}-${fam.licenseFile}`;
    const text = await readFile(join(ROOT, path), 'utf8');
    return { license: classifyLicense(text) || 'Other', licenseUrl: OPTS.rawBase.replace(/\/*$/, '/') + path };
  } catch (e) { return null; } // not fetched locally, or none declared
}

// Joins what this run built with what earlier runs published: a family that
// was not rebuilt keeps its catalog entry, its published files and its group.
async function compose(config, plan, sources, failed, previousCatalog, published) {
  await mkdir(join(DIST, 'assets'), { recursive: true });
  const previous = new Map((previousCatalog && previousCatalog.families || []).map((f) => [f.name, f]));
  const built = new Set(sources.filter((s) => !s.error).map((s) => s.fam.name));
  // Gone from families.json: leaves the catalog and the published set. Only
  // a full build run retires — it is the one that can remove what was
  // published; --catalog-only and --only carry the entry over as it was.
  const undeclared = carriedOver(config, previousCatalog);
  const full = !OPTS.catalogOnly && !OPTS.only;
  const retired = full ? [...new Set([...plan.retired, ...undeclared.map((f) => f.name)])].sort() : [];
  const families = [];
  const stateFamilies = {};
  const add = [];
  const remove = new Set();
  const report = { built: [], kept: 0, failed: [], missing: [], retired, newProblems: [] };

  for (const name of retired) {
    const old = previous.get(name);
    if (old) {
      if (old.licensePath) await rm(join(ROOT, old.licensePath), { force: true });
      for (const p of old.previews || []) await rm(join(ROOT, p.path), { force: true });
    }
    if (published) for (const file of published.files.keys()) if (file.startsWith(name + '_')) remove.add(file);
  }

  for (const row of plan.rows) {
    const fam = row.fam;
    const old = previous.get(fam.name);
    const prev = row.prev; // what an earlier run recorded, if anything
    const source = `${config.upstream} (${fam.source})`;

    if (row.action === 'build' && !failed.has(fam.name) && built.has(fam.name)) {
      const files = [];
      const famOut = join(CPFONTS, fam.name);
      for (const name of (await readdir(famOut)).filter((f) => f.endsWith('.cpfont')).sort()) {
        const bytes = await readFile(join(famOut, name));
        await copyFile(join(famOut, name), join(DIST, 'assets', name));
        files.push({ name, pt: ptFromName(name), size: bytes.length, crc32: crc32(bytes), sha: blobSha(bytes) });
      }
      files.sort((a, b) => a.pt - b.pt);
      add.push(...files.map((f) => f.name));

      const read = await licenseOf(fam);
      const license = (read && read.license) || fam.license || '';
      const licenseUrl = read ? read.licenseUrl : null;
      const group = familyGroup(fam);
      families.push({
        name: fam.name,
        title: fam.title,
        description: fam.description,
        group,
        license,
        licenseUrl,
        // A link only to a file this run could read: one the upstream folder
        // no longer has must not stay in the catalog, pointing at nothing.
        licensePath: read ? `licenses/${fam.name}-${fam.licenseFile}` : null,
        source,
        styles: sources.find((s) => s.fam.name === fam.name).styles.map((s) => s.toLowerCase()),
        sizes: files.map((f) => f.pt),
        files: files.map(({ sha, ...f }) => f),
        previews: config.previewSizes
          .filter((pt) => existsSync(join(ROOT, 'previews', `${fam.name}-${pt}.png`)))
          .map((pt) => ({ pt, path: `previews/${fam.name}-${pt}.png` })),
        totalBytes: files.reduce((n, f) => n + f.size, 0),
      });
      stateFamilies[fam.name] = { fingerprint: row.fingerprint, status: 'built', group, output: Object.fromEntries(files.map((f) => [f.name, f.sha])) };
      report.built.push(fam.name);
      log(`  ${fam.name}: ${files.length} sizes, ${families.at(-1).totalBytes} bytes`);
      // A previous build may have had sizes this one no longer has.
      for (const file of Object.keys((prev && prev.output) || {})) if (!(file in stateFamilies[fam.name].output)) remove.add(file);
      continue;
    }

    // Not built in this run. What was published before keeps serving its
    // users; only the record changes.
    const attempted = row.action === 'build' && !OPTS.catalogOnly;
    const problem = attempted ? 'failed' : row.problem;
    const reason = attempted ? failed.get(fam.name) || 'not built'
      : (prev && prev.reason) || (problem === 'missing' ? `no longer in ${config.upstream} at "${fam.source}"` : undefined);
    if (isNewProblem(row, problem)) report.newProblems.push({ name: fam.name, problem, reason });
    if (attempted) report.failed.push({ name: fam.name, reason });
    else if (problem === 'missing') report.missing.push({ name: fam.name, reason });

    if (old) {
      // A description, title or license edited in families.json reaches the
      // catalog without a rebuild; so does a license text reclassified.
      const read = await licenseOf(fam);
      families.push({ ...old, title: fam.title, description: fam.description || old.description, source,
        license: (read && read.license) || (fam.license !== 'see license file' && fam.license) || old.license,
        licenseUrl: (read && read.licenseUrl) || old.licenseUrl });
      report.kept++;
      if (attempted) log(`  kept the previous build of ${fam.name} (this run failed: ${reason})`);
    }
    if (OPTS.catalogOnly) continue;
    if (!attempted && !problem) {
      // Left exactly as it was — or with nothing recorded, if it never was.
      if (prev) stateFamilies[fam.name] = prev;
    } else {
      stateFamilies[fam.name] = {
        fingerprint: row.fingerprint, status: problem, reason,
        group: (old && old.group) || (prev && prev.group) || familyGroup(fam),
        output: (prev && prev.output) || {},
      };
    }
  }

  if (!full) {
    families.push(...undeclared);
    report.kept += undeclared.length;
  }

  const unchanged = JSON.stringify(families) === JSON.stringify(previousCatalog && previousCatalog.families) && !add.length && !remove.size;
  const catalog = {
    version: 1,
    updated: unchanged && previousCatalog ? previousCatalog.updated : today(),
    generator: `cp-fonts build-fonts.mjs (crossglyph ${CROSSGLYPH_VERSION})`,
    baseUrl: OPTS.baseUrl.replace(/\/*$/, '/'),
    rawBase: OPTS.rawBase.replace(/\/*$/, '/'),
    device: config.device,
    families,
  };
  const state = { version: 1, tool: CROSSGLYPH_VERSION, families: stateFamilies };
  const publishPlan = OPTS.catalogOnly ? { add: [], remove: [] } : { add, remove: [...remove].sort() };
  return { catalog, state, publishPlan, report };
}

// The run's outcome as markdown: readable in the log and in the job summary.
function summary(report) {
  const out = ['## Font build', '',
    `${report.built.length} built, ${report.kept} unchanged, ${report.failed.length} failed to build, ` +
    `${report.missing.length} missing upstream, ${report.retired.length} retired, ${report.newProblems.length} new problems.`];
  const section = (title, items) => {
    if (!items.length) return;
    out.push('', `**${title}**`, '', ...items.slice(0, 40).map((i) => `* ${i.name}: ${i.reason || ''}`));
    if (items.length > 40) out.push(`* ... and ${items.length - 40} more`);
  };
  section('New problems', report.newProblems);
  section('Failed to build', report.failed);
  section('Missing upstream', report.missing);
  if (report.retired.length) out.push('', '**Retired**', '', `* ${report.retired.join(', ')}`);
  return out.join('\n');
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

// ---- main ------------------------------------------------------------------

if (OPTS.report) {
  // The workflow publishes first and asks last, so a problem never keeps the
  // healthy families from reaching the catalog.
  const report = await readJsonOrNull(join(DIST, 'build-report.json'));
  if (!report) throw new Error('no dist/build-report.json: run the build first');
  log(summary(report));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary(report) + '\n');
  process.exit(report.newProblems.length ? 1 : 0);
}

const started = Date.now();
const config = JSON.parse(await readFile(join(ROOT, 'families.json'), 'utf8'));
const previousCatalog = await readJsonOrNull(CATALOG);
// Not given: the ones the catalog already carries, so a local run rewrites
// what CI would instead of a placeholder.
OPTS.baseUrl ||= (previousCatalog && previousCatalog.baseUrl) || '';
OPTS.rawBase ||= (previousCatalog && previousCatalog.rawBase) || '';
if (!OPTS.baseUrl || !OPTS.rawBase) throw new Error('pass --base-url and --raw-base (no catalog to take them from)');
// A mistyped --only would otherwise build nothing and look like a clean run.
const unknown = [...(OPTS.only || [])].filter((name) => !config.families.some((f) => f.name === name));
if (unknown.length) throw new Error(`not in families.json: ${unknown.join(', ')}`);
const badHinting = config.families.filter((f) => f.hinting && !HINTING_MODES.includes(f.hinting));
if (badHinting.length) {
  throw new Error(`hinting must be one of ${HINTING_MODES.join(', ')}: ${badHinting.map((f) => `${f.name} (${f.hinting})`).join(', ')}`);
}

log('1/5 plan…');
const shas = fetchTree(config.upstream, config.upstreamRef);
const previousState = OPTS.force ? null : await readJsonOrNull(STATE);
// What the `fonts` ref serves right now; nothing reads or writes it in a
// catalog-only run.
const published = OPTS.catalogOnly ? null : fetchPublished({ cwd: ROOT });
const plan = planBuild({ config, state: previousState, shas, published: published ? published.files : new Map(),
  tool: CROSSGLYPH_VERSION, only: OPTS.only, force: OPTS.force });
const toBuild = plan.rows.filter((r) => r.action === 'build');
if (OPTS.catalogOnly) {
  log(`  catalog only: ${config.families.length} families, ${toBuild.length} of which a build run would rebuild`);
} else {
  log(`  ${config.families.length} families: ${toBuild.length} to build, ${plan.rows.length - toBuild.length} left as they are` +
    (plan.retired.length ? `, ${plan.retired.length} retired (${plan.retired.join(', ')})` : '') +
    (published ? `; published set: ${published.files.size} files` : '; nothing published yet'));
}

const failed = new Map();
log('2/5 sources…');
const sources = toBuild.length && !OPTS.catalogOnly ? await fetchSources(config, toBuild.map((r) => r.fam)) : [];
for (const s of sources) if (s.error) failed.set(s.fam.name, s.error);

log('3/5 build…');
await buildFamilies(config, sources.filter((s) => !s.error), failed);
await checkGlyphs(sources, failed);

log('4/5 previews…');
await renderPreviews(config, sources.filter((s) => !failed.has(s.fam.name)));

log('5/5 catalog…');
const { catalog, state, publishPlan, report } = await compose(config, plan, sources, failed, previousCatalog, published);
await writeFile(CATALOG, JSON.stringify(catalog, null, 2) + '\n');
// A catalog-only run records nothing: a family it did not build must not be
// stamped with an input it was never built from.
if (!OPTS.catalogOnly) await writeFile(STATE, JSON.stringify(state, null, 2) + '\n');
await writeFile(join(DIST, 'publish.json'), JSON.stringify(publishPlan, null, 2) + '\n');
await writeFile(join(DIST, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
log(`Done in ${Math.round((Date.now() - started) / 1000)} s: ${catalog.families.length} families in the catalog, ` +
  `${publishPlan.add.length} files to publish${publishPlan.remove.length ? `, ${publishPlan.remove.length} to remove` : ''}.`);
log(summary(report));
