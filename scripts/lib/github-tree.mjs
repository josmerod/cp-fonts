// One API call lists every file of a ref with its git blob sha. The build uses
// those shas as its input fingerprints, so it can tell what changed upstream
// without downloading a single font.
import { spawnSync } from 'node:child_process';

// Map(path -> blob sha) for every file of `repo`@`ref`, or an Error.
export function fetchTree(repo, ref) {
  const args = ['-sfL', '--retry', '3',
    `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`];
  // Authenticated when CI (or a `gh auth token` export) provides one: the
  // anonymous quota is 60 requests per hour.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) args.push('-H', 'Authorization: Bearer ' + token);
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`cannot list ${repo}@${ref} (curl exit ${r.status})`);
  const tree = JSON.parse(r.stdout);
  if (tree.truncated) throw new Error(`${repo}@${ref} has more files than one listing can return`);
  return new Map(tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
}
