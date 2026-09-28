# ADR-118 — Measure fallback text with the local renderer's shaping stack

Date: 2026-09-28. Status: accepted with local macOS/Linux qualification; native qualification open.
Requirements: FR-015/037/038/039, via `plans/traceability.csv` to docs 08/05/11.

## Evidence and decision

At 1bee749c, mandatory QA correctly refuses Noto Sans Arabic mixed with Latin or
symbols absent from that primary face. Pango 1.58.2 draws the same synthetic copy
using pinned Noto and Vazirmatn with no unknown glyphs. Truly unsupported U+10FFFF
remains unknown. See output/research/2026-09-28-lean-system-decision/PROBE.json.

Use one bounded native CLI adapter to the stable Pango/Cairo/Fontconfig APIs already
used by librsvg. Keep fontkit for primary-face-only text. Fallback wrapping, advances,
ink bounds and effective styles must be shared by mandatory QA, preparation helpers,
SVG placement and transfer fitting. Preserve the current whitespace wrapping policy
and immutable source copy. Do not change the requested family to evade coverage QA.

The helper receives bounded UTF-8 on stdin and validated numeric arguments, emits a
versioned application-owned JSON protocol, and runs under the same pinned Fontconfig
environment as rasterization. Inspect actual run font files, reject unknown glyphs
and non-admitted files, and bind results to their hashes and helper/runtime identity.
Bound process time, output, input and cache. A missing or failed helper refuses
measurement; it must not silently certify primary-face estimates. Compile at build
time; no runtime compiler, daemon, service or npm dependency.

Retained font evidence includes this measurement implementation identity so recovery
cannot silently change its measurement backend. Runtime version identity is not
a claim of fully hermetic operating-system/shared-library bytes or Canva equivalence.

Qualification exposed missing U+0020 inside Pango symbol runs: the symbol subset
deliberately excluded ordinary spaces, so valid spaced symbols could produce tofu.
Retain U+0020/U+00A0 from the same hash-pinned, licensed DejaVu sources in both
generated symbol faces. Keep letters/digits excluded and existing fallback order.
Record the actual unknown glyph code points, including spaces, in refusal evidence.
Regenerate deterministically and repeat symbol-order and rasterization checks.

## Alternatives

Primary-only widths measure .notdef rather than actual fallback glyphs. Replacing
the whole typeface violates approved style. A pango-view serialization parser would
depend on a format explicitly unsupported across versions. Spawning a CLI per word
adds avoidable overhead; wrapping stays within one bounded process invocation.

## Acceptance

Red-before mixed-font outcome; real shaped multi-font lines and unchanged copy;
genuinely unavailable glyphs remain refused; actual font replacement invalidates
cache; missing helper fails closed. Compare ink bounds/line placement against real
librsvg pixels, direction/tracking/styles, and shared renderer/transfer wrapping.
Run affected historical multilingual fixtures, Core pre-art/selection/final QA and
retained-basis recovery. Verify build and Linux runtime before claiming portability.
Native Canva edit/reopen/export and human language review remain separate gates.

Sources: https://docs.gtk.org/Pango/method.Layout.get_extents.html and
https://docs.gtk.org/Pango/method.Layout.serialize.html, checked 2026-09-28.

## Local qualification

281 tests pass across 24 affected files, with zero failed/skipped. Real librsvg
pixels agree with measured ink bounds on macOS Pango 1.58.2 and Debian Pango
1.50.12 within the declared 2px antialiasing tolerance for the tested cases.
The generated symbol fonts reproduce byte-for-byte with fonttools 4.60.1 and
hash-pinned DejaVu sources. Source/scripts and 529 strict test roots pass.
See `plans/lean-design-implementation-2026-09-28/FALLBACK_MEASUREMENT_PROOF.json`
for red cases, intermediate failures, exact evidence, scope and remaining gates.
