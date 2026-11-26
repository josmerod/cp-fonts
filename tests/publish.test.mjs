import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { fetchPublished, publish, squash } from '../scripts/lib/published.mjs';
import { familyFingerprint, planBuild, STYLES } from '../scripts/lib/plan.mjs';

const REF = 'refs/heads/fonts';
const LEGACY_TAG = 'refs/tags/fonts';
const url = (repo) => pathToFileURL(repo).href;
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
};
const localBlobs = (repo) => git(repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype)')
  .split('\n').filter((t) => t === 'blob').length;
// Loose and packed together: what the remote holds.
const objectCount = (repo) => ['count', 'in-pack']
  .reduce((n, key) => n + Number(new RegExp(`^${key}: (\\d+)`, 'm').exec(git(repo, 'count-objects', '-v'))[1]), 0);
const publishedNames = (repo) => git(repo, 'ls-tree', '-r', '--name-only', REF).split('\n').filter(Boolean);
const tagStatus = (repo) => spawnSync('git', ['ls-remote', '--exit-code', url(repo), LEGACY_TAG], { encoding: 'utf8' }).status;
const configStatus = (repo, key) => spawnSync('git', ['config', '--get', key], { cwd: repo, encoding: 'utf8' }).status;

let dir, seedSha;

// Every call names its checkout and its remote: a default of "origin" in the
// wrong directory would be the real repository.
const to = (checkout, repo) => ({ cwd: join(dir, checkout), remote: url(join(dir, repo)) });
const bareRepo = (name) => {
  const path = join(dir, name);
  git(dir, 'init', '--bare', '-q', '--initial-branch=main', path);
  git(path, 'config', 'uploadpack.allowFilter', 'true'); // lets file:// serve filtered fetches like GitHub
};
const asBot = (repo) => {
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@example.com');
};
// What CI starts from: a checkout that never downloaded the binaries.
const filteredClone = (repo, name) =>
  git(dir, 'clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', url(join(dir, repo)), join(dir, name));
const stage = (name, files) => {
  const path = join(dir, name);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  return path;
};

test.before(() => {
  // A command that needs an object it does not have must fail, not fetch it:
  // that is how these tests tell a real delta from a full transfer in disguise.
  process.env.GIT_NO_LAZY_FETCH = '1';
  dir = mkdtempSync(join(tmpdir(), 'cp-fonts-publish-'));
  bareRepo('remote.git');

  // What an earlier run published: three files, one parentless commit.
  const seed = stage('seed', { 'assets/A_6.cpfont': 'old A_6', 'assets/B_6.cpfont': 'old B_6', 'assets/C_6.cpfont': 'old C_6' });
  git(seed, 'init', '-q', '--initial-branch=fonts');
  git(seed, 'add', '-A');
  asBot(seed);
  git(seed, 'commit', '-q', '-m', 'seed');
  seedSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '-q', url(join(dir, 'remote.git')), `HEAD:${REF}`);
  git(seed, 'push', '-q', url(join(dir, 'remote.git')), `HEAD:${LEGACY_TAG}`); // the legacy tag the old workflow kept updating

  filteredClone('remote.git', 'work');
  asBot(join(dir, 'work'));
});

test.after(() => {
  delete process.env.GIT_NO_LAZY_FETCH;
  rmSync(dir, { recursive: true, force: true });
});

const work = () => to('work', 'remote.git');
const remote = () => join(dir, 'remote.git');

test('the published set is listed without downloading any binary', async () => {
  const published = await fetchPublished(work());
  assert.equal(published.sha, seedSha);
  assert.equal(published.length, 1);
  assert.deepEqual([...published.files.keys()].sort(), ['A_6.cpfont', 'B_6.cpfont', 'C_6.cpfont']);
  assert.equal(published.files.get('A_6.cpfont'), git(remote(), 'rev-parse', `${REF}:assets/A_6.cpfont`));
  assert.equal(localBlobs(join(dir, 'work')), 0, 'no blob should have been fetched');
});

test('with nothing published, the first publish is one parentless commit', async () => {
  bareRepo('empty.git');
  const empty = to('empty', 'empty.git');
  git(dir, 'clone', '-q', empty.remote, join(dir, 'empty'));
  asBot(join(dir, 'empty'));
  assert.equal(await fetchPublished(empty), null);

  const result = publish({ ...empty, base: null, assetsDir: stage('assets-first', { 'A_6.cpfont': 'first A_6' }),
    add: ['A_6.cpfont'], message: 'font builds' });

  assert.equal(git(join(dir, 'empty.git'), 'log', '-1', '--format=%P', REF), '', 'no parent: there was nothing to build upon');
  assert.deepEqual(publishedNames(join(dir, 'empty.git')), ['assets/A_6.cpfont']);
  assert.deepEqual(result.uploaded, ['A_6.cpfont']);
  assert.equal(result.length, 1);
});

test('binaries left on the legacy tag are found, built upon, and the tag goes', async () => {
  bareRepo('tagged.git');
  git(join(dir, 'seed'), 'push', '-q', url(join(dir, 'tagged.git')), `HEAD:${LEGACY_TAG}`);
  const tagged = to('tagged', 'tagged.git');
  filteredClone('tagged.git', 'tagged');
  asBot(join(dir, 'tagged'));

  const base = await fetchPublished(tagged);
  assert.equal(base.sha, seedSha, 'the tag is the published set until the branch exists');
  const result = publish({ ...tagged, base, assetsDir: stage('assets-tagged', { 'B_6.cpfont': 'new B_6' }),
    add: ['B_6.cpfont'], message: 'on top of the tag' });

  assert.equal(git(join(dir, 'tagged.git'), 'rev-parse', REF), result.sha, 'the branch now exists');
  assert.equal(git(join(dir, 'tagged.git'), 'log', '-1', '--format=%P', REF), seedSha,
    'a delta on the tag commit, so nothing is re-uploaded');
  assert.equal(tagStatus(join(dir, 'tagged.git')), 2, 'the legacy tag is deleted');
});

test('a delta is published as a child of the previous commit, uploading only what changed', async () => {
  const base = await fetchPublished(work());
  // Rebuilt: A unchanged bytes, B new bytes. New family: NEW. Retired: C.
  const result = publish({ ...work(), base,
    assetsDir: stage('assets', { 'A_6.cpfont': 'old A_6', 'B_6.cpfont': 'new B_6', 'NEW_6.cpfont': 'new NEW_6' }),
    add: ['A_6.cpfont', 'B_6.cpfont', 'NEW_6.cpfont'], remove: ['C_6.cpfont'], message: 'font builds: +1 ~1 -1' });

  assert.notEqual(result.sha, seedSha);
  assert.equal(git(remote(), 'rev-parse', REF), result.sha, 'the branch moved');
  assert.equal(git(remote(), 'log', '-1', '--format=%P', REF), seedSha, 'the previous commit is the parent');
  assert.equal(git(remote(), 'log', '-1', '--format=%s', REF), 'font builds: +1 ~1 -1');
  assert.deepEqual(publishedNames(remote()), ['assets/A_6.cpfont', 'assets/B_6.cpfont', 'assets/NEW_6.cpfont']);
  assert.equal(git(remote(), 'show', `${REF}:assets/B_6.cpfont`), 'new B_6');
  assert.equal(git(remote(), 'show', `${REF}:assets/A_6.cpfont`), 'old A_6');
  // Only the rebuilt files were uploaded: the two new blobs, not the whole set.
  assert.deepEqual(result.uploaded.sort(), ['B_6.cpfont', 'NEW_6.cpfont']);
  assert.equal(result.length, 2, 'one commit on top of the published one');
  // And the checkout never had to download what was already published.
  assert.equal(localBlobs(join(dir, 'work')), 3, 'only the blobs staged for this run exist locally');
  // "fonts" means exactly one ref now.
  assert.equal(tagStatus(remote()), 2, 'the legacy tag should have been deleted');

  // The plan reads that listing as it is. A state recorded against it must
  // plan no rebuild — a mismatch in key shape here would rebuild everything,
  // on every run, while every unit test of the plan still passed.
  const tool = '0.9.1';
  const config = {
    upstream: 'someone/fonts', upstreamRef: 'HEAD', sizes: [6], intervals: 'reading', previewSizes: [6], device: 'x4',
    families: ['A', 'B', 'NEW'].map((name) => ({ name, source: `Modified Fonts/${name}`, title: name, description: '' })),
  };
  const shas = new Map(config.families.flatMap((f) => STYLES.map((style) => [`${f.source}/${f.name}-${style}.ttf`, `${f.name}:${style}`])));
  const listed = await fetchPublished(work());
  const state = { version: 1, tool, families: Object.fromEntries(config.families.map((f) => [f.name, {
    fingerprint: familyFingerprint(config, f, shas, tool), status: 'built', group: 'Reading',
    output: { [`${f.name}_6.cpfont`]: listed.files.get(`${f.name}_6.cpfont`) },
  }])) };
  const plan = planBuild({ config, state, shas, published: listed.files, tool });
  assert.deepEqual(plan.rows.filter((r) => r.action === 'build'), []);
});

test('reading the published set does not turn the checkout into one that fetches on demand', async () => {
  // A plain checkout with the remote configured, as CI has it.
  git(dir, 'init', '-q', join(dir, 'plain'));
  const plain = to('plain', 'remote.git');
  git(plain.cwd, 'remote', 'add', 'origin', plain.remote);
  asBot(plain.cwd);

  const base = await fetchPublished(plain);

  assert.equal(base.sha, git(remote(), 'rev-parse', REF));
  assert.equal(localBlobs(plain.cwd), 0);
  assert.equal(configStatus(plain.cwd, `remote.${plain.remote}.promisor`), 1,
    'without a promisor remote, a command that needs a missing binary fails instead of downloading the set');
  // The behaviour itself, with the net the other tests run under taken away.
  const env = { ...process.env };
  delete env.GIT_NO_LAZY_FETCH;
  const asked = spawnSync('git', ['cat-file', '-e', base.files.get('A_6.cpfont')], { cwd: plain.cwd, encoding: 'utf8', env });
  assert.notEqual(asked.status, 0, 'a published binary the checkout never downloaded must not be fetched on demand');
  assert.equal(localBlobs(plain.cwd), 0, 'nothing was downloaded behind the caller\'s back');
});

test('squash folds the chain into one parentless commit with the same content', async () => {
  const plain = to('plain', 'remote.git');
  const base = await fetchPublished(plain);
  assert.equal(base.length, 2);
  const objects = objectCount(remote());

  const commit = squash({ ...plain, tip: base.sha, message: 'font builds' });

  assert.equal(git(remote(), 'rev-parse', REF), commit);
  assert.equal(git(remote(), 'log', '-1', '--format=%P', REF), '', 'the chain is gone: old binaries are no longer reachable');
  assert.equal(git(remote(), 'rev-parse', `${REF}^{tree}`), git(remote(), 'rev-parse', `${base.sha}^{tree}`), 'same content');
  // It is a full transfer, deliberately: the whole set is fetched to be sent again.
  assert.equal(localBlobs(plain.cwd), 3, 'every published file, fetched up front');
  assert.equal(objectCount(remote()), objects + 1, 'nothing else is new to the remote');
  // The next run builds on the squashed tip as on any other.
  assert.equal((await fetchPublished(plain)).length, 1);
});

test('squash refuses to overwrite a ref that moved since it was read', async () => {
  const plain = to('plain', 'remote.git');
  const before = git(remote(), 'rev-parse', REF);
  assert.throws(() => squash({ ...plain, tip: seedSha, message: 'stale' }), /moved since it was read/);
  assert.equal(git(remote(), 'rev-parse', REF), before, 'the branch was not touched');
});

test('a file missing from the staging folder fails before anything is pushed', async () => {
  const before = git(remote(), 'rev-parse', REF);
  const base = await fetchPublished(work());
  assert.throws(
    () => publish({ ...work(), base, assetsDir: join(dir, 'assets'), add: ['A_6.cpfont', 'GONE_6.cpfont'], message: 'nope' }),
    /not built, refusing to publish: GONE_6\.cpfont/);
  assert.equal(git(remote(), 'rev-parse', REF), before, 'the branch was not touched');
});

test('removing most of the published set is refused unless explicitly allowed', async () => {
  const before = git(remote(), 'rev-parse', REF);
  const base = await fetchPublished(work());
  const wipe = (extra) => publish({ ...work(), base, assetsDir: join(dir, 'assets'), add: ['A_6.cpfont'],
    remove: ['B_6.cpfont', 'NEW_6.cpfont'], message: 'nope', ...extra });

  assert.throws(() => wipe({}), /refusing to remove 2 of 3 published files/);
  assert.equal(git(remote(), 'rev-parse', REF), before, 'the branch was not touched');

  wipe({ allowPrune: true });
  assert.deepEqual(publishedNames(remote()), ['assets/A_6.cpfont']);
});

test('a run that only retires families publishes a removal with nothing staged', async () => {
  const base = await fetchPublished(work());
  rmSync(join(dir, 'assets'), { recursive: true, force: true });
  const result = publish({ ...work(), base, assetsDir: join(dir, 'assets'), add: [], remove: ['A_6.cpfont'],
    allowPrune: true, message: 'font builds: 0 published, 1 removed' });

  assert.deepEqual(publishedNames(remote()), []);
  assert.deepEqual(result.uploaded, []);
  assert.equal(result.length, base.length + 1);
});
