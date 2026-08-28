# cp-fonts

Precompiled `.cpfont` font families for **CrossPoint** readers (Xteink X4 Pro),
built automatically from the curated allowlist in [`families.json`](families.json)
with [CrossGlyph](https://github.com/CrazyCoder/crossglyph) — the converter that
uses the reader's own render core.

Every family is rasterized to bitmap fonts at **sizes 6–18 pt** (one
`Familia_N.cpfont` per size, 4 grey levels, Regular/Bold/Italic/BoldItalic),
with page previews rendered by the device's actual renderer.

Consumed by the **Fonts** plugin for the CrossPoint web UI
(see the `fonts/` plugin in your `sd-plugins` fork), which browses
[`catalog/fonts.json`](catalog/fonts.json), shows the previews, and streams the
selected families and sizes straight to `/.fonts/<Familia>/` on the SD card.

## Layout

| Path | What |
|---|---|
| `families.json` | Curated allowlist + build settings. **This is the input you edit.** |
| `scripts/build-fonts.mjs` | The whole pipeline (dependency-free Node 20+). |
| `catalog/fonts.json` | Generated catalog: families, sizes, files with `size`+`crc32`, preview paths. |
| `previews/` | Generated page previews (PNG, `--device x4` geometry). |
| `licenses/` | Upstream license file per family (carried from WP-Fonts). |
| `.github/workflows/build-fonts.yml` | Weekly + on-push build; assets to the rolling `fonts` release. |
| `workspace/`, `tools/`, `dist/` | Local caches + staging (git-ignored). |

## Adding a family

1. Pick one from [Chairzard/WP-Fonts](https://github.com/Chairzard/WP-Fonts)
   (or any TTF/OTF source — then extend `fetchSources` accordingly).
2. Add an entry to `families.json` — `name` must match `[A-Za-z0-9_-]+`
   (firmware constraint), and the folder must contain at least a Regular face
   named `<name>-Regular.ttf`.
3. Run locally:

   ```sh
   node scripts/build-fonts.mjs
   ```

   First run downloads CrossGlyph into `tools/` (~6 MB) and the TTFs into
   `workspace/`. Later runs are incremental (unchanged families are not
   re-rasterized). Check `previews/<Familia>-6.png` — if 6 pt looks too light
   or crowded, add a per-family `workspace/fonts/conf/<Familia>.conf`
   (`darkness`, `weight`, `hinting`, …) and re-run.
4. Commit. CI rebuilds, publishes the `.cpfont` files to the rolling
   [`fonts`](../../releases/tag/fonts) release and commits the regenerated
   catalog/previews/licenses back to `main`.

## Local install without the plugin

Copy a family folder out of `workspace/fonts/cpfonts/<Familia>/` to `/.fonts/`
on the SD card (or upload it at `http://crosspoint.local/fonts`), then pick the
family under Settings → Font on the reader.

## Licenses

Fonts keep their upstream licenses (OFL unless noted); the per-family files
live in [`licenses/`](licenses/). The build and CI code in this repo are MIT.
WP-Fonts renames every modified family (`WP…` prefix) to comply with OFL
reserved-name clauses — keep those names when adding families from it.
