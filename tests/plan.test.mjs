import assert from 'node:assert/strict';
import test from 'node:test';
import { familyFingerprint, planBuild, STYLES } from '../scripts/lib/plan.mjs';

const TOOL = '0.9.1';
const fam = (name, extra = {}) => ({
  name, source: 'Modified Fonts/' + name, title: name, description: '', licenseFile: 'OFL.txt', ...extra,
});
function config(families = [fam('A'), fam('B'), fam('C')], extra = {}) {
  return {
    upstream: 'someone/fonts', upstreamRef: 'HEAD', sizes: [6, 14], intervals: 'reading',
    previewSizes: [6, 14], device: 'x4', families, ...extra,
  };
}
// Every family has four faces upstream; `gone` removes paths, `changed`
// re-stamps them (an upstream edit).
function upstream(cfg, { gone = [], changed = [] } = {}) {
  const shas = new Map();
  for (const f of cfg.families) {
    for (const style of STYLES) {
      const path = `${f.source}/${f.name}-${style}.ttf`;
      if (!gone.includes(path)) shas.set(path, (changed.includes(path) ? 'new:' : 'old:') + path);
    }
    shas.set(`${f.source}/OFL.txt`, 'lic:' + f.name);
  }
  return shas;
}
// The state a run leaves behind once it built `names` from `cfg`.
function stateAfter(cfg, shas, names = cfg.families.map((f) => f.name)) {
  const families = {};
  for (const f of cfg.families.filter((x) => names.includes(x.name))) {
    const output = {};
    for (const pt of cfg.sizes) output[`${f.name}_${pt}.cpfont`] = `blob:${f.name}:${pt}`;
    families[f.name] = { fingerprint: familyFingerprint(cfg, f, shas, TOOL), status: 'built', group: 'Reading', output };
  }
  return { version: 1, tool: TOOL, families };
}
// Keyed the way fetchPublished() lists the `fonts` ref: <File>.cpfont, no path.
const publishedAfter = (state) => new Map(
  Object.values(state.families).flatMap((f) => Object.entries(f.output).map(([name, sha]) => [name, sha])));

const names = (plan, action) => plan.rows.filter((r) => r.action === action).map((r) => r.fam.name);

test('without a previous state every family is built', () => {
  const cfg = config();
  const plan = planBuild({ config: cfg, state: null, shas: upstream(cfg), published: new Map(), tool: TOOL });
  assert.deepEqual(names(plan, 'build'), ['A', 'B', 'C']);
  assert.deepEqual(plan.retired, []);
});

test('a family is kept while its input and its published files are unchanged', () => {
  const cfg = config();
  const shas = upstream(cfg);
  const state = stateAfter(cfg, shas);
  const plan = planBuild({ config: cfg, state, shas, published: publishedAfter(state), tool: TOOL });
  assert.deepEqual(names(plan, 'keep'), ['A', 'B', 'C']);
  assert.deepEqual(plan.rows.filter((r) => r.isNewProblem), []);
});

test('a family is rebuilt when any of its source files changes upstream', () => {
  const cfg = config();
  const shas = upstream(cfg);
  const state = stateAfter(cfg, shas);
  const plan = planBuild({
    config: cfg, state, shas: upstream(cfg, { changed: ['Modified Fonts/B/B-Bold.ttf'] }),
    published: publishedAfter(state), tool: TOOL,
  });
  assert.deepEqual(names(plan, 'build'), ['B']);
  assert.deepEqual(names(plan, 'keep'), ['A', 'C']);
});

test('a family is rebuilt when its license file changes upstream', () => {
  const cfg = config();
  const shas = upstream(cfg);
  const state = stateAfter(cfg, shas);
  const next = upstream(cfg);
  next.set('Modified Fonts/C/OFL.txt', 'lic:new');
  const plan = planBuild({ config: cfg, state, shas: next, published: publishedAfter(state), tool: TOOL });
  assert.deepEqual(names(plan, 'build'), ['C']);
});

test('a family is rebuilt when its hinting setting changes', () => {
  const cfg = config();
  const shas = upstream(cfg);
  const state = stateAfter(cfg, shas);
  const tuned = config([fam('A', { hinting: 'light' }), fam('B'), fam('C')]);
  const plan = planBuild({ config: tuned, state, shas, published: publishedAfter(state), tool: TOOL });
  assert.deepEqual(names(plan, 'build'), ['A']);
  assert.deepEqual(names(plan, 'keep'), ['B', 'C']);
});

test('a family is rebuilt when one of its published binaries is gone', () => {
  const cfg = config();
  const shas = upstream(cfg);
  const state = stateAfter(cfg, shas);
  const published = publishedAfter(state);
  published.delete('A_14.cpfont');
  const plan = planBuild({ config: cfg, state, shas, published, tool: TOOL });
  assert.deepEqual(names(plan, 'build'), ['A']);
  assert.deepEqual(names(plan, 'keep'), ['B', 'C']);
});

test('a family is rebuilt when a published binary differs from the recorded one', () => {
  const cfg = config();
  const shas = upstream(cfg);
  const state = stateAfter(cfg, shas);
  const published = publishedAfter(state);
  published.set('B_6.cpfont', 'blob:something-else');
  const plan = planBuild({ config: cfg, state, shas, published, tool: TOOL });
  assert.deepEqual(names(plan, 'build'), ['B']);
});

test('a family removed upstream is kept for its users and reported once', () => {
  const cfg = config();
  const shas = upstream(cfg);
  const state = stateAfter(cfg, shas);
  const published = publishedAfter(state);
  const next = upstream(cfg, { gone: ['Modified Fonts/B/B-Regular.ttf'] });

  const first = planBuild({ config: cfg, state, shas: next, published, tool: TOOL });
  assert.deepEqual(names(first, 'keep'), ['A', 'B', 'C']);
  const b = first.rows.find((r) => r.fam.name === 'B');
  assert.equal(b.problem, 'missing');
  assert.equal(b.isNewProblem, true, 'a family that just vanished upstream needs a human');

  // Once recorded as missing it is not reported again on every weekly run.
  state.families.B.status = 'missing';
  const later = planBuild({ config: cfg, state, shas: next, published, tool: TOOL });
  assert.equal(later.rows.find((r) => r.fam.name === 'B').isNewProblem, false);
});

test('a family declared in families.json but absent upstream is reported and never built', () => {
  const cfg = config([fam('A'), fam('Ghost')]);
  const plan = planBuild({ config: cfg, state: null, shas: upstream(cfg, { gone: ['Modified Fonts/Ghost/Ghost-Regular.ttf'] }),
    published: new Map(), tool: TOOL });
  assert.deepEqual(names(plan, 'build'), ['A']);
  const ghost = plan.rows.find((r) => r.fam.name === 'Ghost');
  assert.equal(ghost.action, 'skip');
  assert.equal(ghost.isNewProblem, true);
});

test('a family removed from families.json is retired from the catalog', () => {
  const cfg = config([fam('A'), fam('B')]);
  const before = config([fam('A'), fam('B'), fam('C')]);
  const shas = upstream(before);
  const state = stateAfter(before, shas);
  const plan = planBuild({ config: cfg, state, shas, published: publishedAfter(state), tool: TOOL });
  assert.deepEqual(plan.retired, ['C']);
  assert.deepEqual(names(plan, 'keep'), ['A', 'B']);
});

test('a family that failed to build is tried again every run, and reported once per input', () => {
  const cfg = config();
  const shas = upstream(cfg);
  const state = stateAfter(cfg, shas, ['A', 'C']);
  state.families.B = { ...state.families.A, fingerprint: familyFingerprint(cfg, fam('B'), shas, TOOL), status: 'failed', output: {} };
  const published = publishedAfter(state);

  // Retried (it may have been a one-off failure), but not new: the input is
  // the one that was already reported.
  const sameInput = planBuild({ config: cfg, state, shas, published, tool: TOOL });
  assert.deepEqual(names(sameInput, 'build'), ['B']);
  assert.equal(sameInput.rows.find((r) => r.fam.name === 'B').problem, 'failed');
  assert.equal(sameInput.rows.find((r) => r.fam.name === 'B').isNewProblem, false);

  const newInput = planBuild({
    config: cfg, state, shas: upstream(cfg, { changed: ['Modified Fonts/B/B-Italic.ttf'] }), published, tool: TOOL,
  });
  assert.deepEqual(names(newInput, 'build'), ['B']);
  assert.equal(newInput.rows.find((r) => r.fam.name === 'B').isNewProblem, true, 'still failing on new input is worth a look');
});

test('a family that failed after being published is retried, keeping its last good output on record', () => {
  const cfg = config();
  const shas = upstream(cfg);
  const state = stateAfter(cfg, shas);
  const published = publishedAfter(state);
  state.families.B.status = 'failed';
  const plan = planBuild({ config: cfg, state, shas, published, tool: TOOL });
  assert.deepEqual(names(plan, 'keep'), ['A', 'C']);
  const b = plan.rows.find((r) => r.fam.name === 'B');
  assert.equal(b.action, 'build');
  assert.equal(b.problem, 'failed');
  assert.deepEqual(Object.keys(b.prev.output), ['B_6.cpfont', 'B_14.cpfont'], 'what readers can still be served');
});

test('changing the sizes or the tool version rebuilds every family', () => {
  const cfg = config();
  const shas = upstream(cfg);
  const base = familyFingerprint(cfg, fam('A'), shas, TOOL);
  assert.equal(familyFingerprint({ ...cfg, sizes: [6, 14, 18] }, fam('A'), shas, TOOL) === base, false);
  assert.equal(familyFingerprint({ ...cfg, previewSizes: [12] }, fam('A'), shas, TOOL) === base, false);
  assert.equal(familyFingerprint(cfg, fam('A'), shas, '0.9.2') === base, false);
  assert.equal(familyFingerprint(cfg, fam('A'), upstream(cfg), '0.9.1'), base, 'identical input, identical fingerprint');
});

test('--force rebuilds every family', () => {
  const cfg = config();
  const shas = upstream(cfg);
  const state = stateAfter(cfg, shas);
  const plan = planBuild({ config: cfg, state, shas, published: publishedAfter(state), tool: TOOL, force: true });
  assert.deepEqual(names(plan, 'build'), ['A', 'B', 'C']);
});

test('--only builds the listed families and retires nothing', () => {
  const cfg = config([fam('A'), fam('B')]);
  const before = config([fam('A'), fam('B'), fam('C')]);
  const shas = upstream(before);
  const state = stateAfter(before, shas);
  const plan = planBuild({ config: cfg, state, shas, published: publishedAfter(state), tool: TOOL, only: new Set(['A']) });
  assert.deepEqual(names(plan, 'build'), ['A']);
  assert.deepEqual(names(plan, 'keep'), ['B']);
  assert.deepEqual(plan.retired, []);

  const fresh = planBuild({ config: cfg, state: null, shas: upstream(cfg), published: new Map(), tool: TOOL, only: new Set(['B']) });
  assert.deepEqual(names(fresh, 'build'), ['B']);
  assert.deepEqual(names(fresh, 'skip'), ['A']);
});
