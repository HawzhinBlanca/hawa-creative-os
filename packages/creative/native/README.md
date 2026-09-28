# Local fallback text measurement

ADR-118 uses the same Pango/Cairo/Fontconfig stack as librsvg for mixed-font copy.
This is a build artifact, not a long-running service. The application runs it with
bounded stdin/output/time and validates actual fonts against the pinned inventory.

Build with `pnpm build:native` at the repository or package root. Normal package
build and test commands build it first. Direct `pnpm exec vitest run ...` assumes
it has already been built. Do not copy a macOS binary into a Linux image.

Requirements: C11 compiler, pkg-config, pangocairo and pangoft2 development files.
Debian: `build-essential pkg-config libpango1.0-dev`; macOS: the existing Homebrew
Pango/Cairo/Fontconfig installation and compiler. The production builder installs
headers/compiler; the runner uses runtime libraries already supplied with librsvg.

Protocol version 1 is owned here. Six numeric arguments are size, width, spacing
in px, RTL, bold, italic. Stdin is family + newline + normalized UTF-8 copy.
The TypeScript adapter owns existing whitespace normalization and preserves the
original copy/hash. The helper uses the same greedy word wrapping inside one
process. Output includes actual run files/indices, unknown code points, advance
widths and ink rectangles relative to each line's baseline.

Safety limits: 16 KiB stdin, 512 emitted lines, 3-second process timeout, 2 MiB
output, 128 cache entries and 8 MiB retained cache. Cache keys cover effective
inputs, actual font inventory and helper/runtime identity. Missing helper never
falls back to guessed successful measurements. Runtime version strings and binary
hashes do not attest all operating-system or shared-library bytes. Native Canva
qualification remains a separate requirement.
