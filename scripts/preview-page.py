"""Write one preview page of a family, the way `crossglyph preview --png` does,
but with the settings the family is built with.

    python scripts/preview-page.py <workspace> <family> <size> <device> <png>

`crossglyph preview --png` rasterizes with the default tuning whatever the
family's .conf says, so a family built with a `hinting` of its own would be
shown another way than readers get it. This is the last step of that command
given the family's own Tuning: the same page, byte for byte, for a family that
sets nothing.

It runs inside CrossGlyph's environment — build-fonts.mjs starts it the way
CrossGlyph's own launcher starts the tool — and follows that tool's internals
(crossglyph.preview.server), so it is pinned to one CrossGlyph version like
everything else here.
"""
import pathlib
import sys

from crossglyph import fontbuild
from crossglyph.preview import server

workspace, family, size, device, out = sys.argv[1:6]
fontbuild.SOURCE_DIR = pathlib.Path(workspace).resolve()
config = server.family_config(family)
faces = dict(config.styles)
server.set_font_source(faces["regular"], family=config.name, bold=faces.get("bold"),
                       italic=faces.get("italic"), bold_italic=faces.get("bolditalic"))
font = server.build_font(server._sources, float(size), tuning=config.tuning,
                         axes={style: dict(coords) for style, coords
                               in server.axes_for(server._family or "", float(size))})
page = server.preview_page(font, spec=server.PageSpec(device=device))
server._watermark(page).save(out)
