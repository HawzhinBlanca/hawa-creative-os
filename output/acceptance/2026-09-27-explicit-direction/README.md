# Explicit Studio direction — 2026-09-27

Exact runtime hashes are in fixtures.json and R19_EXPLICIT_DIRECTION_PROOF.json.
Capture used an uncommitted fix based on 8e79320; hashes identify actual source.
One synthetic Canva design, three real exports, six exact PPTX strings and preserved
color runs. Explicit LTR no longer becomes RTL; absent LTR metadata remains unknown
and visual review is required. Three unchanged box crops have zero changed pixels,
while the mixed control changes 9,247. Human review remains not_reviewed.

The original failing control is in 2026-09-27-canva-locale and remains unchanged.
No production restart, task approval, native editing transaction or message.

## Reproduce

`node --import tsx build_fixtures.mts` creates immutable inputs once.
`node --import tsx capture_live.mts` journals one import and three exports before
submission, resumes known jobs, and refuses ambiguous resubmission or changed inputs.
`analyze.py [implementation-commit]` verifies retained artifacts offline; without
an argument the checkout must match every frozen source hash.
The native text tool flattens paragraphs; only PPTX is exact paragraph evidence.

## Tests

red.json/focused.json: sandbox database denial, zero tests.
red-authorized.json: three failures/three passes on baseline.
focused-authorized.json: 42 passed before final fixture type repair.
final-tests.json: 67 passed, zero skipped; final project/script/test types and lint pass.
