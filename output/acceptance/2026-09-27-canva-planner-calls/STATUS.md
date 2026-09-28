# Canva planner qualification — 2026-09-27

Source 63a0c85, accounting correction 4a65f74, tested and fresh runtime
**6c1f8b5**. Full suite: **4104 passed, zero failed, 59 skipped**, 490 passing
and 7 skipped files, 122.05 seconds. Source/scripts and 498 strict test roots
compile; lint 982/1053 with nine existing egress exceptions, Desk build and
security/11-pattern self-test pass. Three actual process-kill boundaries and
the historical pre-056 upgrade are covered.

Fresh matching Core/worker/Desk images have no changed source. One selected
synthetic workflow passes 63 invariants; 43 scenarios unselected and two
unmatched fake Gemini paths remain. All 29 Chrome/runtime checks pass: one
planner request retains its typed layout despite missing usage, named terminal
cost evidence preserves the original receipt, actual Core restart recovers the
editable source, and repeated resume keeps one Canva import with no added model
request. Temporary synthetic administrator revoked; screenshot inspected.

The first full run exposed ten Studio failures. Transfer artifacts share the
plan table but already use the Studio ledger; a validated immutable Studio-run
origin and historical backfill fix the misclassification without inventing
planner calls or changing source bytes. All initial failures remain recorded.

Health at 13:20 UTC/16:20 Baghdad is degraded: PostgreSQL/Restate connected,
zero paused/backoff/inbox, live Canva/model/Telegram API unverified, design
flags off. The read-only status check at 13:22:57 UTC confirms that state.
No real provider call or production change.

Next: truthful Operations zero-sample SLO and legacy monthly-budget defaults;
other typed result recovery; real office/provider/native Canva, human
multilingual/design and held-out quality/retrieval/cost admission; independent-
host restore and controlled rollout. Native Canva after-preview approval remains
pending. The Telegram paid classifier is dormant in current callers; preserve
its client egress boundary. Whole-app goal remains active. See
R21_CANVA_PLANNER_CALLS_PROOF.json and runbooks/CANVA_PLANNER_RECOVERY.md.


The final full suite supersedes preliminary overlapping runs; their counts are not summed. The latest 59 skipped tests remain unexecuted. Local qualification does not establish a production-ready system.
