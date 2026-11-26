// Planning for the incremental build: which families have to be built again,
// given what each one is built from, what the previous run recorded, and what
// is actually published on the `fonts` ref. Pure functions, no I/O.
import { createHash } from 'node:crypto';

export const STYLES = ['Regular', 'Bold', 'Italic', 'BoldItalic'];

// What families.json may say in a family's `hinting`, CrossGlyph's values.
export const HINTING_MODES = ['normal', 'light', 'none', 'auto'];

// The upstream file a style comes from. families.json may map styles to exact
// upstream filenames (OTF extensions, TeX-style -Roman base faces).
export function sourceFile(fam, style) {
  return (fam.files && fam.files[style.toLowerCase()]) || `${fam.name}-${style}.ttf`;
}

// Everything that can change a family's output: its source files (by git blob
// sha, so an upstream edit is detected without downloading anything), its
// license file, the rasterization settings and the converter version.
export function familyFingerprint(config, fam, shas, tool) {
  const files = STYLES.map((style) => {
    const path = `${fam.source}/${sourceFile(fam, style)}`;
    return [style, shas.get(path) ?? null];
  });
  const license = fam.licenseFile
    ? [fam.licenseFile, shas.get(`${fam.source}/${fam.licenseFile}`) ?? null, fam.licenseUrl || null]
    : null;
  return createHash('sha256').update(JSON.stringify({
    tool,
    sizes: config.sizes,
    intervals: config.intervals,
    previewSizes: config.previewSizes,
    device: config.device,
    name: fam.name,
    source: fam.source,
    files,
    license,
    hinting: fam.hinting || null,
  })).digest('hex');
}

// One row per family. `action` is 'build' (rasterize it again), 'keep' (leave
// its catalog entry and published files alone) or 'skip' (nothing to keep).
// `published` is the listing of the `fonts` ref as fetchPublished() returns
// it: Map(<File>.cpfont -> blob sha). `problem` says why a kept family needs
// attention, and `isNewProblem` is true
// only on the run that first saw it, so a known issue does not turn every
// weekly run red. `retired` lists recorded families that families.json no
// longer declares: they leave the catalog and the published set.
export function planBuild({ config, state, shas, published, tool, only = null, force = false }) {
  const previous = new Map(Object.entries((state && state.families) || {}));
  const declared = new Set(config.families.map((f) => f.name));

  const rows = config.families.map((fam) => {
    const prev = previous.get(fam.name);
    const row = { fam, fingerprint: familyFingerprint(config, fam, shas, tool), prev, action: 'keep', problem: null, isNewProblem: false };
    const hasSource = shas.has(`${fam.source}/${sourceFile(fam, 'Regular')}`);

    if (only && !only.has(fam.name) && !prev) { row.action = 'skip'; return row; }

    if (!prev || force || (only && only.has(fam.name))) {
      // A declared family with no Regular face upstream can never be built.
      if (!hasSource && !prev) { row.action = 'skip'; row.problem = 'missing'; }
      else if (!hasSource) row.problem = 'missing';
      else row.action = 'build';
      return row;
    }
    if (only) return row; // outside --only: leave it exactly as it is

    if (!hasSource) {
      // Upstream dropped the family. What it published still works, so it
      // stays in the catalog until families.json is cleaned up.
      row.problem = 'missing';
      return row;
    }
    row.problem = prev.status === 'built' ? null : prev.status;

    const sameInput = prev.fingerprint === row.fingerprint;
    // `published` is what fetchPublished() listed: <File>.cpfont -> blob sha.
    const stillPublished = Object.entries(prev.output || {}).every(([name, sha]) => published.get(name) === sha);
    if (prev.status === 'built' && sameInput && stillPublished) return row;
    // A failed build is tried again on every run — a download or the
    // rasterizer can fail once — and reported as new once per input.
    row.action = 'build';
    return row;
  });

  // New: no record of this very problem for this very input.
  for (const row of rows) row.isNewProblem = isNewProblem(row, row.problem);

  const retired = only ? [] : [...previous.keys()].filter((name) => !declared.has(name));
  return { rows, retired };
}

// The catalog entries of the families families.json no longer declares. A run
// that retires nothing (--catalog-only, --only) carries them into the new
// catalog as they are: left out, they would drop out unrecorded, their
// published files still served. A full build run retires them instead.
export function carriedOver(config, catalog) {
  const declared = new Set(config.families.map((f) => f.name));
  return ((catalog && catalog.families) || []).filter((f) => !declared.has(f.name));
}

// True when `problem` is not what an earlier run already recorded for the
// row's input, so a known issue does not turn every weekly run red.
export function isNewProblem(row, problem = row.problem) {
  const { prev } = row;
  if (problem === null) return false;
  if (!prev || prev.status !== problem) return true;
  // A vanished source changes the fingerprint all by itself; that is the same
  // problem, not a new one.
  return problem !== 'missing' && prev.fingerprint !== row.fingerprint;
}
