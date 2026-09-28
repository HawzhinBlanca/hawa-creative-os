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


### Refreshed candidate and full regression qualification

Implementation `34eac23`, sealed candidate `8dd04cc`: the refreshed isolated app
passes all 36 workflow invariants, with real offline Docling and synthetic external
providers/identities. Core/Desk/worker image labels match the candidate, runtime
source changes are empty, and four list/detail QA reads agree. Compiled Core/QA
evaluate two retained real Canva files: corrected direction requires visual review,
old explicit direction conflict fails, and altered canonical task copy fails both.
Compiled Studio respects all six requested directions. No provider/model call
is needed for these compiled checks. The first probe used the wrong report-field
name; that probe error was corrected without changing runtime code.

First full regression: 3,685 passed/2 failed/59 skipped. Both failures were old
backup expectations superseded by ADR-081. Updated tests require corrupt/locked
packs to fail before restore with unknown store counts, and incomplete cloud
transport to fail before a dump/upload/collection. Isolated backup follow-up 6/6
passed; final full regression **3,687 passed, zero failed,
59 skipped** across 464 files. Test types pass. Runtime is unchanged
from candidate 8dd04cc; the final full run includes the uncommitted test-only correction.
Earlier failed test receipts remain in the proof.

This is engineering evidence for the isolated candidate. Production, actual human
review, native edit/save/reopen, mixed-token isolation and live delivery remain
unqualified; Workspace reviewer configuration, off-host/independent recovery and
held-out creative quality/cost gates remain open. See R19_EXPLICIT_DIRECTION_PROOF.json.
