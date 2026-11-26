// The published binaries live on the `fonts` ref as assets/<File>.cpfont.
// A filtered fetch brings that commit's trees but none of its blobs, so a run
// can tell what is already published — and assemble the next commit on top of
// it — without downloading the files that did not change.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

export const PUBLISH_REF = 'refs/heads/fonts';
// Earlier workflows pushed to an unqualified "fonts", which kept moving the
// tag left behind by the old rolling release. The binaries are still there
// until the branch's first publish, which then deletes it.
const LEGACY_TAG = 'refs/tags/fonts';

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed (${r.status}): ${(r.stderr || '').trim()}`);
  return r.stdout;
}

// exit 2: no such ref on the remote.
const lsRemote = (cwd, remote, ref) =>
  spawnSync('git', ['ls-remote', '--exit-code', remote, ref], { cwd, encoding: 'utf8' });

const readConfig = (cwd, key) => {
  const r = spawnSync('git', ['config', '--get', key], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

// `git fetch --filter` turns the checkout into a promisor clone, where any
// later git command may quietly download what is missing — the whole
// published set, if a push is ever wrong. So the fetch runs behind this,
// which puts the configuration back afterwards: a missing object then fails
// loudly instead of being fetched behind the caller's back.
function withoutBecomingPromisor(cwd, remote, run) {
  // `extensions.partialclone` is what marks a partial clone. The git versions
  // at hand set it on `clone --filter` only; it is put back as well, should a
  // fetch ever write it.
  const keys = [`remote.${remote}.promisor`, `remote.${remote}.partialclonefilter`, 'extensions.partialclone'];
  const before = keys.map((key) => readConfig(cwd, key));
  run();
  keys.forEach((key, i) => {
    if (readConfig(cwd, key) === before[i]) return;
    if (before[i] === null) spawnSync('git', ['config', '--unset', key], { cwd });
    else git(cwd, ['config', key, before[i]]);
  });
}

// { sha, files: Map(<File>.cpfont -> blob sha), length: commits on the ref }
// for what is published, or null when nothing has been published yet.
export function fetchPublished({ cwd = process.cwd(), remote = 'origin' } = {}) {
  let ref = PUBLISH_REF;
  let probe = lsRemote(cwd, remote, ref);
  if (probe.status === 2) {
    ref = LEGACY_TAG;
    probe = lsRemote(cwd, remote, ref);
    if (probe.status === 2) return null;
  }
  if (probe.status !== 0) throw new Error(`cannot look up ${ref} on ${remote}: ${(probe.stderr || '').trim()}`);

  withoutBecomingPromisor(cwd, remote, () => git(cwd, ['fetch', '--quiet', '--filter=blob:none', remote, ref]));
  // Peeled: the legacy ref is a tag, and an annotated one is an object of its
  // own, which is no parent for a commit.
  const sha = git(cwd, ['rev-parse', 'FETCH_HEAD^{commit}']).trim();
  const files = new Map();
  for (const line of git(cwd, ['ls-tree', '-r', sha]).split('\n')) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\tassets\/(.+)$/);
    if (m) files.set(m[2], m[1]);
  }
  const length = Number(git(cwd, ['rev-list', '--count', sha]).trim());
  return { sha, files, length };
}

// Writes the staged files as blobs and publishes a commit holding exactly what
// was published plus `add` minus `remove` — or just `add` as a parentless
// commit when nothing is published yet. Because the commit is a child of the
// published one, git sends just the new blobs. Returns the new commit, the
// files that actually had to be uploaded and the length of the commit chain.
export function publish({ cwd = process.cwd(), remote = 'origin', ref = PUBLISH_REF, base = null, assetsDir,
  add, remove = [], allowPrune = false, message }) {
  const paths = add.map((name) => join(assetsDir, name));
  const missing = paths.filter((p) => !existsSync(p));
  if (missing.length) throw new Error('not built, refusing to publish: ' + missing.map((p) => basename(p)).join(', '));
  // Nothing short of a deliberate decision may drop most of the catalog: a
  // truncated families.json or a plan gone wrong must stop here, not here
  // and on every reader.
  if (base && !allowPrune && remove.length > base.files.size / 2) {
    throw new Error(`refusing to remove ${remove.length} of ${base.files.size} published files `
      + '(more than half) — pass --allow-prune if that is intended');
  }

  // hash-object prints one sha per path, in order (and takes no empty list).
  const shas = paths.length
    ? git(cwd, ['hash-object', '-w', '--stdin-paths'], paths.join('\n') + '\n').trim().split('\n')
    : [];
  const entries = new Map(base ? base.files : []);
  for (const name of remove) entries.delete(name);
  add.forEach((name, i) => entries.set(name, shas[i]));

  // Trees are assembled from shas alone, so the already-published blobs are
  // never read (--missing lets them stay undownloaded). mktree takes no
  // blank line: an empty tree is an empty input.
  const lines = [...entries].map(([name, sha]) => `100644 blob ${sha}\t${name}`);
  const assetsTree = git(cwd, ['mktree', '--missing'], lines.length ? lines.join('\n') + '\n' : '').trim();
  const root = git(cwd, ['mktree', '--missing'], `040000 tree ${assetsTree}\tassets\n`).trim();
  const parent = base ? base.sha : null;
  const commit = git(cwd, ['commit-tree', root, ...(parent ? ['-p', parent] : []), '-m', message]).trim();

  // Not forced: the commit is a child of what the server has, so anything
  // else at the ref means another run got there first. --no-thin, because a
  // thin pack would make git read the neighbours of each new blob — the very
  // download the filtered fetch exists to avoid.
  git(cwd, ['push', '--quiet', '--no-thin', remote, `${commit}:${ref}`]);
  if (lsRemote(cwd, remote, LEGACY_TAG).status === 0) git(cwd, ['push', '--quiet', remote, `:${LEGACY_TAG}`]);

  return { sha: commit, uploaded: add.filter((name, i) => !base || base.files.get(name) !== shas[i]),
    length: base ? base.length + 1 : 1 };
}

// Replaces the ref's history with a single parentless commit holding the same
// tree, so the old binaries stop being reachable and the repository stops
// growing. It is not cheap: a commit without parents shares nothing with the
// tip, so git has to send every object again. Hence an explicit full fetch
// first — never the object-by-object download a promisor clone would do.
export function squash({ cwd = process.cwd(), remote = 'origin', ref = PUBLISH_REF, tip, message }) {
  git(cwd, ['fetch', '--quiet', '--refetch', '--depth', '1', '--no-filter', remote, ref]);
  if (git(cwd, ['rev-parse', 'FETCH_HEAD^{commit}']).trim() !== tip) throw new Error(`${ref} moved since it was read — run again`);
  const tree = git(cwd, ['rev-parse', `${tip}^{tree}`]).trim();
  const commit = git(cwd, ['commit-tree', tree, '-m', message]).trim();
  // The lease keeps a run from overwriting a ref that moved since `tip`.
  git(cwd, ['push', '--quiet', '--no-thin', `--force-with-lease=${ref}:${tip}`, remote, `${commit}:${ref}`]);
  return commit;
}
