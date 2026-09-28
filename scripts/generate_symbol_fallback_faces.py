#!/usr/bin/env python3
"""
Cuts the symbol faces the renderer falls back to (HawaSymbols-Regular.ttf, HawaSymbols-Bold.ttf) from
DejaVu Sans 2.37 (ADR-036, font pinning).

    python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools==4.60.1
    mkdir -p /tmp/dejavu && docker run --rm --network none -v /tmp/dejavu:/out <core image> \
        cp /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf /out/
    /tmp/ft/bin/python scripts/generate_symbol_fallback_faces.py /tmp/dejavu [--check]

Why: the copy gate (classifyCopyScript in apps/core/src/services/canva-design-planner.ts, and the same
check in design-studio-service.ts) admits arrows, mathematical operators, geometric shapes,
miscellaneous symbols and dingbats, so contact lines such as "☎ 0750 …  ✉ info@…" reach the renderer.
In the core image those glyphs came from fonts-dejavu-core under /usr/share/fonts. Once every
rsvg-convert call was pinned to a generated fontconfig listing only assets/fonts (and Verdana), 803
admitted code points no longer had a glyph in any visible face and ☎ ✉ were drawn as hex boxes.

What is kept: every DejaVu Sans glyph in the gate's non-letter ranges (1035 code points), plus ordinary
and nonbreaking spaces. Pango can include inter-symbol spaces in the fallback run; excluding them
produced missing glyphs for valid text such as "☎ ✉ ➤" (ADR-118). The generated fontconfig
(font-environment.ts) appends "Hawa Symbols" to each Latin family, so a
symbol the requested face has is still drawn by it and one it lacks comes from these faces. In the image
such a symbol came from the first system font in fontconfig's order that had it: DejaVu Sans for most,
Vazirmatn or Arial (not redistributable) for some; left to the pinned set's order, pango took ✓ ★ → from
Inter for a Cinzel or Verdana line. Arabic-script families keep fontconfig's order, so the "•" of a
stored Kurdish footer is drawn as before; what no face draws (☎ ✉) still comes from here. The faces
carry no letters or digits, so text is drawn by the requested face, or for a family
that does not exist by the same fallback face as before (Vazirmatn). U+27BF is the one symbol the image
drew that is not restored: only DejaVu Sans Mono Bold has it.

They are renamed "Hawa Symbols" so nothing mistakes them for the full DejaVu Sans; the licence is
committed beside them (LICENSE-DejaVu.txt). Output is deterministic: --check regenerates into memory
and exits 1 when a committed file differs.
"""
import hashlib
import io
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "packages/creative/assets/fonts"
FAMILY = "Hawa Symbols"
# fonts-dejavu-core 2.37-6 (Debian bookworm), as installed in the core image.
SOURCES = {
    "Regular": ("DejaVuSans.ttf", "abdc775b21b1bc470d50c97e790d276f2054b7504e56e5bd3e64f48d68582322"),
    "Bold": ("DejaVuSans-Bold.ttf", "0d977336a6d5fba34eab8e3199eb218327161b5143749f802982c2bc34df0c96"),
}
# The ranges classifyCopyScript admits outside the Latin and Arabic letters.
GATE_SYMBOL_RANGES = [
    (0x2000, 0x206F),  # general punctuation
    (0x20A0, 0x20CF),  # currency
    (0x2100, 0x214F),  # letterlike symbols
    (0x2190, 0x21FF),  # arrows
    (0x2200, 0x22FF),  # mathematical operators
    (0x25A0, 0x25FF),  # geometric shapes
    (0x2600, 0x27BF),  # miscellaneous symbols and dingbats
]


def set_names(font: TTFont, style: str) -> None:
    name = font["name"]
    version = name.getDebugName(5) or "Version 2.37"
    ps = f"HawaSymbols-{style}"
    for nid in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
        name.removeNames(nameID=nid)
    name.setName(FAMILY, 1, 3, 1, 0x409)
    name.setName(style, 2, 3, 1, 0x409)
    name.setName(f"{version.replace('Version ', '')};{ps};cut from DejaVu Sans", 3, 3, 1, 0x409)
    name.setName(FAMILY if style == "Regular" else f"{FAMILY} {style}", 4, 3, 1, 0x409)
    name.setName(ps, 6, 3, 1, 0x409)
    name.names = [n for n in name.names if n.platformID == 3]


def cut(source: Path, style: str, keep: set) -> bytes:
    font = TTFont(source, recalcTimestamp=False)
    cmap = font.getBestCmap()
    unicodes = sorted(cp for cp in cmap if cp in keep)
    options = subset.Options()
    options.recalc_timestamp = False
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.layout_features = ["*"]
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    set_names(font, style)
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check = "--check" in sys.argv[1:]
    if len(args) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    source_dir = Path(args[0])
    keep = {0x20, 0xA0} | {cp for lo, hi in GATE_SYMBOL_RANGES for cp in range(lo, hi + 1)}
    differs = 0
    for style, (file, sha) in SOURCES.items():
        source = source_dir / file
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if digest != sha:
            print(f"{source} is not DejaVu Sans 2.37 from fonts-dejavu-core 2.37-6 (sha256 {digest})", file=sys.stderr)
            return 1
        data = cut(source, style, keep)
        target = OUT / f"HawaSymbols-{style}.ttf"
        if check:
            same = target.exists() and target.read_bytes() == data
            print(f"{target.name}: {'ok' if same else 'DIFFERS'}")
            differs += 0 if same else 1
        else:
            target.write_bytes(data)
            kept = len(TTFont(io.BytesIO(data)).getBestCmap())
            print(f"{target.name}: {kept} code points, {len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()}")
    return 1 if differs else 0


if __name__ == "__main__":
    sys.exit(main())
