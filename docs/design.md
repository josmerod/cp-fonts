# cp-fonts — design (updated 2026-11-26)

Goal: precompiled `.cpfont` families (6–18 pt) for the Xteink X4 Pro, published
from git, installable from the reader's web UI with previews and per-size
selection. Two repos: this one (fonts factory) and the **Fonts** plugin
(`josmerod/fonts.crosspoint-plugin`, listed in the CrossPoint Plugin Hub).

## Verified facts this design rests on

- `.cpfont` = one bitmap file per point size inside a family folder; firmware
  loads from `/.fonts/<Familia>/` (preferred) or `/fonts/`; filenames must match
  `[A-Za-z0-9_-]+\.cpfont`; magic `CPFONT\0\0`.
- Active family = `sdFontFamilyName` in `/.crosspoint/settings.json`.
- Web server: `GET /api/fonts` (installed families + sizes + `maxFamilies`
  = 128), `POST /api/fonts/upload`, `POST /api/fonts/delete`. Uploaded fonts
  appear in Settings → Font **without reboot** (confirmed on device,
  2026-08-28 spike: WPCharter, WPGaramond, WPIlliterata).
- CrossGlyph 0.9.1 CLI: incremental `build`, headless `preview --png
  --device x4`, `key = value` confs, `CI=1` for no update checks. Its output is
  deterministic across Windows and Linux (same bytes for the same input,
  checked 2026-11-26), which is what lets a local trial stand in for CI.
- Two things CrossGlyph 0.9.1 does not do from its command line. `preview
  --png` rasterizes with the default tuning whatever the family's conf says,
  so a family tuned in its conf is drawn another way than it is built; the
  last step of that command, given the family's own settings, is what
  `scripts/preview-page.py` does. And the tool's Python environment is
  reachable only the way its launcher reaches it (`uv run --project <version>
  …`, with the uv bundled in the release).
- Some fonts ship TrueType instructions that make FreeType's native hinting
  (CrossGlyph's `hinting = normal`) collapse an outline. FreeType renders the
  glyph empty and raises nothing, so the build succeeds and the `.cpfont`
  carries a gap. Rendering every face of the 325 families at the 13 sizes
  with FreeType found exactly one family whose glyphs come out empty or
  thinned this way: GFS Galatea, whose bold lost 86 Latin letters and digits
  and whose regular lost strokes at small sizes. `auto` (FreeType's
  auto-hinter) fixes both and gives it the most solid ink of the three
  alternatives.
- Everything is served from `raw.githubusercontent.com`: the binaries from the
  `fonts` branch, the catalog, previews and licenses from `main`. It sends no
  redirects (the reader's `api.fetchToSd` does not follow them) and CORS
  headers.
- `GET /api.github.com/repos/<repo>/git/trees/<ref>?recursive=1` lists every
  file of a ref with its git blob sha: the build reads upstream changes from it
  without downloading a single font (60 requests an hour anonymously; CI
  authenticates).

## Pipeline (this repo)

`families.json` (curated allowlist) → `scripts/build-fonts.mjs`:

1. **Plan** (`scripts/lib/plan.mjs`). Every family gets a fingerprint of its
   inputs: the blob shas of its source and license files upstream, the sizes,
   the preview sizes, the device, its `hinting` setting and the CrossGlyph
   version. Compared with `catalog/build-state.json` (what the last runs built
   from) and with what the `fonts` branch actually holds, that gives per
   family: build, keep, or nothing to keep. A failed build is retried on every
   run; a family gone upstream stays in the catalog for its users and is
   reported once.
2. **Sources.** Only the families to build are downloaded, each into a clean
   folder. `all.conf` carries the sizes and coverage; a family with a
   `hinting` of its own gets a conf of its own that overrides that one key.
3. **Build.** One `crossglyph build` for the batch; what it could not build is
   retried alone, so one broken source is reported by name instead of sinking
   the run. CrossGlyph itself is unpacked only when its zip hashes to the
   pinned `CROSSGLYPH_ZIP_SHA256` in `scripts/build-fonts.mjs`: a fingerprint
   names the tool by version, and a release uploaded again must not pass for
   it. Then every file built is read back (`scripts/lib/cpfont.mjs`)
   and checked for blank letters: a style with a single empty ASCII letter or
   digit, or five or more empty Latin ones, makes the family a failed build.
   A few empty glyphs are normal (sources map rare characters to nothing), so
   the count is what tells a collapsed font apart; of the 3,731 binaries
   published before the check existed, it flagged the one broken family and
   let three families with isolated gaps through.
4. **Previews** for the families built in this run, several at a time. This
   step was the bulk of a full rebuild (one tool start per preview), which is
   why not rendering unchanged ones matters most. A family with a `hinting` of
   its own is rendered by `scripts/preview-page.py`, with that setting.
5. **Catalog.** `compose` joins what this run built with what earlier runs
   published: families, sizes, files with `size` + `crc32`, previews, license
   (classified from the license text), functional group (read from the font's
   own tables: Reading, Interface, Mono, Script, Display). It writes
   `catalog/fonts.json`, `catalog/build-state.json`, `dist/publish.json` (the
   files to publish and to remove) and `dist/build-report.json`.

Nothing is cached in CI: an unchanged family costs no download, no build and
no preview, so a run with nothing to do spends its time on checkout and tests.

## Publishing (`scripts/lib/published.mjs`)

The binaries live on the `fonts` branch as `assets/<Familia>_<pt>.cpfont`.
`scripts/publish-binaries.mjs` publishes what `dist/publish.json` lists as one
commit holding exactly the previous set plus the new files minus the removed
ones:

- `git fetch --filter=blob:none` brings the published commit's trees but none
  of its blobs, and `git ls-tree` lists the published files with their shas —
  the whole set is known without downloading it.
- The new files are written as blobs (`hash-object -w`), the trees are
  assembled from shas alone (`mktree --missing`), and the commit is created
  with `commit-tree` **as a child of the published tip**. A normal push then
  sends just the new blobs; it is not forced, so a ref that moved underneath
  is left alone.
- The first publish finds the binaries on the tag the earlier workflow left,
  builds on top of it and deletes the tag.

Two guards stand between a bad plan and every reader: publishing stops if a
file to publish is missing, and if more than half of the published set would
be removed (`--allow-prune` says otherwise).

**History is folded now and then, not every time.** A commit without parents
shares nothing with the tip, so git re-sends every object: a squash is a full
transfer of the set (about 850 MB today), not a free rewrite. It happens after
30 commits on the branch or on `--squash`, after an explicit full fetch
(`--refetch --depth 1 --no-filter`), under a lease on the tip.

What was learned the hard way, for whoever touches this next:

- `git fetch --filter` turns the checkout into a *promisor* clone, and the
  filter sticks: a later `git pull` inherits it and any missing object is
  downloaded on demand — the whole published set, if a push is ever wrong.
  `fetchPublished` puts the configuration back, so a missing object fails
  instead.
- A remote given as a local path ignores filters unless the bare repository
  sets `uploadpack.allowFilter=true`; the tests create theirs with it.
- The tests run with `GIT_NO_LAZY_FETCH=1`: a command that needs an object it
  does not have fails rather than fetching, which is how a "delta" that is
  really a full transfer in disguise gets caught.

## CI (`.github/workflows/build-fonts.yml`)

Weekly (to pick up upstream WP-Fonts changes), on pushes to `main` that touch
`families.json`, the scripts or the workflow, and by hand with `rebuild`,
`prune` and `squash` inputs. Steps, in this order: git identity (publishing
creates its commit with git plumbing, which needs an author, and a fresh runner
has none); tests; build (nothing
cached); publish; commit catalog, previews, licenses and build state back to
`main`; report last, so a problem never keeps the healthy families from the
catalog and the run goes red only for a problem not seen before. One run at a
time (`concurrency`), and the catalog commit is rebased onto a `main` that may
have moved meanwhile.

The first run after this change builds everything: there was no state to
compare with. It uploads the whole set once; every run after it is a delta.

## Catalog schema (`catalog/fonts.json`)

```jsonc
{
  "version": 1,
  "updated": "2026-11-26",
  "baseUrl": "…/raw…/cp-fonts/fonts/assets/",   // .cpfont files
  "rawBase": "…/raw…/cp-fonts/main/",           // previews + licenses
  "device": "x4",
  "families": [{
    "name": "WPCharter", "title": "…", "description": "…", "group": "Reading",
    "license": "Bitstream", "licenseUrl": "…", "licensePath": "licenses/…", "source": "Chairzard/WP-Fonts (…)",
    "styles": ["regular", "bold", "italic", "bolditalic"],
    "sizes": [6,7,8,9,10,11,12,13,14,15,16,17,18],
    "files": [{ "name": "WPCharter_6.cpfont", "pt": 6, "size": 172987, "crc32": 862742411 }],
    "previews": [{ "pt": 6, "path": "previews/WPCharter-6.png" }],
    "totalBytes": 5048531
  }]
}
```

Kept close to the firmware's official `fonts.json` manifest (which also keys on
per-file `crc32`), so a future firmware fork could point its built-in downloader
at this catalog. `description` is curated by hand in `families.json`; a
`--catalog-only` run brings title, description and license edits into the
catalog without building anything, and keeps the entry of a family that
`families.json` no longer declares: only a full build run retires it.

## Resyncing with upstream (`scripts/gen-families.mjs`)

Reads the upstream tree listing, never the fonts. A folder becomes a family
when it has a base face (Regular, or Roman/Book/Text/Rg, or the bare family
name) and a license file; the styles are matched against the family stem, so
`-BookItalic`, `-Regular-Italic`, `-Bd It` or a date stamp in the file name are
all read. Entries already in `families.json` keep their curated title and
description; their styles are re-read, and any difference is reported. The few
folders the rules cannot read — a stem upstream uses twice, a license kept in
the original project — are listed in `OVERRIDES`. It exits non-zero while an
entry is not backed upstream.

## Plugin side (`josmerod/fonts.crosspoint-plugin`)

Settings-mount `plugin.js`: browse catalog (raw fetch, `fetchToSd` fallback),
families grouped by function with collapsible sections, preview images on
request, checkbox per size (default all), install selected via
`fetchToSd('/.fonts/<Familia>/<file>')` with rollback on error, installed state
from `GET /api/fonts`, remove via `POST /api/fonts/delete`, activate via
settings.json write (`sdFontFamilyName`).

## Deferred

- `device.json` on-device browse.
- Other open-font sources beyond WP-Fonts (google/fonts and the foundries'
  own repositories) — they need a quality filter first, since most of what is
  published is not meant for long-form reading.
- Registry caps at 128 installed families; the plugin warns at the limit.
