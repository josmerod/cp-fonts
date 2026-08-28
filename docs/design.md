# cp-fonts — design (validated 2026-08-28)

Goal: precompiled `.cpfont` families (6–18 pt) for the Xteink X4 Pro, published
from git, installable from the reader's web UI with previews and per-size
selection. Approved architecture: two repos — this one (fonts factory) and a
`fonts/` plugin in an `sd-plugins` fork.

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
  --device x4`, `key = value` confs, `CI=1` for no update checks.
- `api.fetchToSd` does **not** follow redirects → release-asset URLs must be
  resolved with `relay HEAD` hops first (pattern proven by the `dictionaries`
  plugin). raw.githubusercontent URLs never redirect and send CORS headers.

## Pipeline (this repo)

`families.json` (curated allowlist) → `scripts/build-fonts.mjs`:

1. Download the 4 style TTFs per family from WP-Fonts (raw URLs, curl fallback).
2. Generate `workspace/fonts/conf/all.conf` (`sizes`, `intervals = reading`).
3. `crossglyph build` (incremental; `--fail-on-warning`; pinned tool version,
   auto-downloaded to `tools/`).
4. `crossglyph preview --png` per family at 6 and 14 pt (`--device x4`).
5. Emit `catalog/fonts.json` (files with `size` + `crc32`, preview/license
   paths, `baseUrl` = rolling release, `rawBase` = raw GitHub) and stage
   `dist/assets/*.cpfont`.

CI (`.github/workflows/build-fonts.yml`): weekly + on `families.json` push;
caches `workspace/` + `tools/`; uploads assets to the rolling `fonts` release;
commits catalog + previews + licenses back to `main` (they are served via
raw.githubusercontent to the plugin).

## Catalog schema (`catalog/fonts.json`)

```jsonc
{
  "version": 1,
  "updated": "2026-08-28",
  "baseUrl": "…/releases/download/fonts/",   // .cpfont files (redirect → resolve)
  "rawBase": "…/raw…/main/",                 // previews + licenses (no redirect)
  "device": "x4",
  "families": [{
    "name": "WPCharter", "title": "…", "description": "…",
    "license": "OFL", "licensePath": "licenses/…", "source": "Chairzard/WP-Fonts (…)",
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
at this catalog.

## Plugin side (sd-plugins fork, `fonts/`)

Settings-mount `plugin.js`: browse catalog (raw fetch, `fetchToSd` fallback),
preview images, checkbox per size (default all), install selected via
`fetchToSd('/.fonts/<Familia>/<file>')` with redirect resolution + rollback on
error, installed state from `GET /api/fonts`, remove via `POST
/api/fonts/delete`, activate via settings.json write (`sdFontFamilyName`).

## Deferred

- `device.json` on-device browse (bundle downloader already follows redirects).
- Scaling past the curated set (quality per family needs per-family tuning;
  registry caps at 128 families).
- Upstream PR offering a curated subset to the official `crosspoint-fonts`.
