#!/usr/bin/env node
// Publish what build-fonts.mjs staged to the `fonts` ref, which
// raw.githubusercontent.com serves straight to readers.
//
// Reads dist/publish.json ({ add, remove }): a run that built nothing
// publishes nothing, and a run that built a few families uploads only their
// files. The commit goes on top of what the ref already holds, so git sends
// just the new blobs (lib/published.mjs).
//
// Usage: node scripts/publish-binaries.mjs [--dry-run] [--allow-prune] [--squash]
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPublished, publish, PUBLISH_REF, squash } from './lib/published.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const SQUASH = process.argv.includes('--squash');
// Each publishing run adds a commit, and every binary it replaced stays
// reachable, so the repository would only ever grow. A chain this long is
// folded back into one commit — which moves the whole set twice, so not on
// every run.
const CHAIN_LIMIT = 30;
const here = { cwd: ROOT };

let plan;
try {
  plan = JSON.parse(await readFile(join(ROOT, 'dist', 'publish.json'), 'utf8'));
} catch {
  console.log('Nothing to publish: this run built nothing.');
  process.exit(0);
}
if (!plan.add.length && !plan.remove.length) {
  console.log('Nothing to publish: no binary changed.');
  process.exit(0);
}

// What the ref holds right now: the commit this one goes on top of.
const base = fetchPublished(here);
console.log(`${base ? `Delta on ${base.sha.slice(0, 10)} (${base.files.size} files)` : 'First publish'}: ` +
  `${plan.add.length} files to publish, ${plan.remove.length} to remove${DRY ? ' (dry run)' : ''}.`);
if (DRY) process.exit(0);

const message = `font builds: ${plan.add.length} published, ${plan.remove.length} removed`;
const { sha, uploaded, length } = publish({ ...here, base, assetsDir: join(ROOT, 'dist', 'assets'), add: plan.add,
  remove: plan.remove, allowPrune: process.argv.includes('--allow-prune'), message });
let tip = sha;
console.log(`Published to ${PUBLISH_REF} as ${sha.slice(0, 10)}: ${uploaded.length} files uploaded (${length} commits on the ref).`);

// Housekeeping: never worth a red run, the delta is already out.
if (SQUASH || length >= CHAIN_LIMIT) {
  try {
    tip = squash({ ...here, tip: sha, message });
    console.log(`Folded ${length} commits into one (${tip.slice(0, 10)}).`);
  } catch (e) {
    console.warn(`Not folded this time: ${e.message}`);
  }
}
