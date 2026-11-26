# cp-fonts

Precompiled `.cpfont` font families for **CrossPoint** readers (Xteink X4 Pro),
built automatically from the curated allowlist in [`families.json`](families.json)
with [CrossGlyph](https://github.com/CrazyCoder/crossglyph) — the converter that
uses the reader's own render core.

Every family is rasterized to bitmap fonts at **sizes 6–18 pt** (one
`Familia_N.cpfont` per size, 4 grey levels, Regular/Bold/Italic/BoldItalic),
with page previews rendered by the device's actual renderer.

Consumed by the **Fonts** plugin for the CrossPoint web UI
([`josmerod/fonts.crosspoint-plugin`](https://github.com/josmerod/fonts.crosspoint-plugin),
listed in the CrossPoint Plugin Hub), which browses
[`catalog/fonts.json`](catalog/fonts.json), shows the previews, and streams the
selected families and sizes straight to `/.fonts/<Familia>/` on the SD card.

## Layout

| Path | What |
|---|---|
| `families.json` | Curated allowlist + build settings. **This is the input you edit.** |
| `scripts/gen-families.mjs` | Resyncs `families.json` with the upstream WP-Fonts tree. |
| `scripts/build-fonts.mjs` | Plans and builds what changed (dependency-free Node 20+). |
| `scripts/publish-binaries.mjs` | Publishes the changed binaries to the `fonts` branch. |
| `scripts/lib/` | The parts that are unit-tested: plan, license, publishing, upstream tree, `.cpfont` reader. |
| `scripts/preview-page.py` | Renders a preview with the family's own settings (used for a family that sets `hinting`). |
| `catalog/fonts.json` | Generated catalog: families, sizes, files with `size`+`crc32`, preview paths. |
| `catalog/build-state.json` | What each published family was built from (its input fingerprint). |
| `previews/` | Generated page previews (PNG, `--device x4` geometry). |
| `licenses/` | Upstream license file per family (carried from WP-Fonts). |
| `.github/workflows/build-fonts.yml` | Weekly + on-push build; binaries to the `fonts` branch. |
| `workspace/`, `tools/`, `dist/` | Local caches + staging (git-ignored). |

## Adding a family

1. Resync with [Chairzard/WP-Fonts](https://github.com/Chairzard/WP-Fonts):

   ```sh
   node scripts/gen-families.mjs --dry-run
   ```

   It lists every folder upstream that ships a Regular face and a license and
   is not declared yet, the entries whose styles upstream changed, and the
   ones whose folder is gone. Run it without `--dry-run` to add them
   (`--prune` also drops the stale ones). For a source that is not WP-Fonts,
   add an entry to `families.json` by hand.

2. Write its `description` — one line on what the typeface is and how it
   reads — and check that `name` matches `[A-Za-z0-9_-]+` (firmware
   constraint).

3. Try it locally:

   ```sh
   node scripts/build-fonts.mjs --only Familia
   ```

   The first run downloads CrossGlyph into `tools/` (~6 MB) and the font
   files into `workspace/`. It needs `curl` and `unzip` on the PATH (both
   come with Git Bash on Windows), and lists the upstream tree with one
   GitHub API call: export `GH_TOKEN` when the anonymous quota is used up.
   Check `previews/Familia-6.png`: if the family is
   reported for blank glyphs, or 6 pt looks broken, give its entry a
   `hinting` of its own (see below) and re-run.

4. Commit. CI builds the new family, publishes its `.cpfont` files to the
   `fonts` branch and commits the regenerated catalog, previews and licenses
   back to `main`.

## How the build stays incremental

A family is fingerprinted by its inputs: the git blob shas of its source and
license files upstream (read from the tree listing, without downloading the
fonts), the sizes, its `hinting` setting, and the CrossGlyph version. Each run
records the fingerprint of what it built in `catalog/build-state.json`. On the
next run a family whose fingerprint is unchanged and whose files are still
published is left alone — not downloaded, not built, not previewed. Only what
changed goes through the pipeline, and only those binaries are uploaded, as
one commit on top of what the `fonts` branch already holds.

A family that fails to build is retried on every run and reported by name; a
family removed from `families.json` leaves the catalog and the published set.
The run goes red only for a problem it has not reported before, so one broken
upstream folder cannot turn every weekly run red.

A build can also succeed and still be unusable: some fonts carry instructions
that make CrossGlyph's default hinting collapse their outlines (GFS Galatea's
bold came out with a third of its letters missing). So every file built is
checked for blank letters before anything of its family is previewed or
published, and a family that fails the check is reported like a failed build.
Such a family needs `"hinting": "auto"` (or `light` or `none`) in its
`families.json` entry, which makes CrossGlyph fit its outlines another way.
Its preview is then rendered with that same setting, because
`crossglyph preview --png` draws every family with the default one.

Useful flags:

| Flag | Effect |
|---|---|
| `--only a,b` | Build just these families; leave every other one alone. |
| `--force` | Rebuild everything (new CrossGlyph, new sizes, migration). |
| `--catalog-only` | Refresh titles, descriptions and licenses from `families.json`; builds nothing, records nothing. |
| `--jobs N` | Parallel downloads and previews. |
| `node scripts/build-fonts.mjs --report` | Exit status from the last run's `dist/build-report.json`. |

On the publishing side, `node scripts/publish-binaries.mjs --dry-run` shows
what would be uploaded; removing more than half of the published set is
refused unless `--allow-prune` is given, and `--squash` folds the `fonts`
history into one commit (it moves the whole set, so it is done only now and
then — automatically every 30 commits).

## Checks

```sh
node --test tests/*.test.mjs
```

## Local install without the plugin

Copy a family folder out of `workspace/fonts/cpfonts/<Familia>/` to `/.fonts/`
on the SD card (or upload the files through the reader's web page, the one
File Transfer opens), then pick the family under Settings → Font on the reader.

## Licenses

Fonts keep their upstream licenses; the per-family files live in
[`licenses/`](licenses/). The catalog names each license from the text of
that file, not from its name, and links to it. The build and CI code in this
repo are MIT. WP-Fonts renames its modified families to respect the reserved
font names of the originals — keep those names when adding families from it.
