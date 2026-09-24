#!/usr/bin/env python3
"""
Cuts the static Inter faces the renderer draws from the variable Inter file (ADR-036, font pinning).

    python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools==4.60.1
    /tmp/ft/bin/python scripts/generate_inter_static_instances.py [--check]

Why: packages/creative/assets/fonts/Inter-Regular.ttf used to be Inter 4.001's variable font (axes opsz
14-32 and wght 100-900). fontkit measures its default instance (opsz 14), while pango, through
fontconfig and cairo, sets the optical size from the drawn size, so display lines were drawn about 7%
narrower than they were measured (60 px) and every Inter block was wrapped and centred on a width it
was not drawn at. A static face has no variation tables, so every reader gets the same outlines.

opsz is pinned at 14 because every named instance in the variable file (Thin to Black) sits at 14,
and because it is the instance fontkit already measured with: no Inter wrap decision changes, only the
drawing moves to match it. The weights are the ones the product asks for (400 in the studio renderer;
500 to 900 in the operation templates, which used to get them from the variable file's instances).

The source is apps/desk/public/fonts/Inter-Regular.ttf, the same variable file (checked by hash).
Output is deterministic (no timestamp recalculation): --check regenerates into memory and exits 1
when a committed file differs.
"""
import hashlib
import io
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "apps/desk/public/fonts/Inter-Regular.ttf"
SOURCE_SHA256 = "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031"
OUT = ROOT / "packages/creative/assets/fonts"
OPSZ = 14
WEIGHTS = {
    400: "Regular",
    500: "Medium",
    600: "SemiBold",
    700: "Bold",
    800: "ExtraBold",
    900: "Black",
}


def set_names(font: TTFont, style: str) -> None:
    """Family 'Inter' with the weight as its style, the way the official static files name themselves."""
    ribbi = style in ("Regular", "Bold")
    name = font["name"]
    version = name.getDebugName(5) or "Version 4.001"
    ps = f"Inter-{style}"
    # Drop every name the instancer may have derived from the STAT table, then write a plain set.
    for nid in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
        name.removeNames(nameID=nid)
    name.setName("Inter" if ribbi else f"Inter {style}", 1, 3, 1, 0x409)
    name.setName(style if ribbi else "Regular", 2, 3, 1, 0x409)
    name.setName(f"{version.replace('Version ', '')};RSMS;{ps};opsz{OPSZ}", 3, 3, 1, 0x409)
    name.setName("Inter" if style == "Regular" else f"Inter {style}", 4, 3, 1, 0x409)
    name.setName(ps, 6, 3, 1, 0x409)
    if not ribbi:
        name.setName("Inter", 16, 3, 1, 0x409)
        name.setName(style, 17, 3, 1, 0x409)
    # Mac-platform names would disagree with the ones above; the Windows set is what readers use.
    name.names = [n for n in name.names if n.platformID == 3]


def cut(weight: int, style: str) -> bytes:
    font = TTFont(SOURCE, recalcTimestamp=False)
    static = instancer.instantiateVariableFont(font, {"opsz": OPSZ, "wght": weight}, inplace=False)
    # A static face keeps no STAT: it would describe axes the file no longer has.
    if "STAT" in static:
        del static["STAT"]
    set_names(static, style)
    static["OS/2"].usWeightClass = weight
    fs = static["OS/2"].fsSelection
    fs &= ~(1 | 32 | 64)  # italic, bold, regular bits
    fs |= 32 if style == "Bold" else 64 if style == "Regular" else 0
    static["OS/2"].fsSelection = fs
    static["head"].macStyle = 1 if style == "Bold" else 0
    buf = io.BytesIO()
    static.save(buf)
    return buf.getvalue()


def main() -> int:
    check = "--check" in sys.argv[1:]
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        print(f"{SOURCE} is not the variable Inter 4.001 this was cut from (sha256 {digest})", file=sys.stderr)
        return 1
    differs = 0
    for weight, style in WEIGHTS.items():
        data = cut(weight, style)
        target = OUT / f"Inter-{style}.ttf"
        if check:
            same = target.exists() and target.read_bytes() == data
            print(f"{target.name}: {'ok' if same else 'DIFFERS'}")
            differs += 0 if same else 1
        else:
            target.write_bytes(data)
            print(f"{target.name}: {len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()}")
    return 1 if differs else 0


if __name__ == "__main__":
    sys.exit(main())
