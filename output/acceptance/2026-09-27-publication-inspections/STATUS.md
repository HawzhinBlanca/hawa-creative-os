# Scheduled Google publication inspections — local qualification

## Final local qualification — 2026-09-27

Tested and running isolated candidate **b38f60dd**: **4,237 passed, zero failed,
60 skipped** (505 passing/7 skipped files). Final lint passes; source build and 513
strict test roots passed before qualification. The selected deployed rehearsal passes
63 invariants, with 43 scenarios unselected and external providers simulated. Two fake
Gemini calls are outside the fixture coverage. This is not real-provider acceptance.

The Operations browser check shows saved scheduled checks with timestamps and evidence
hashes, and correctly labels incomplete Google/permission evidence as unverified.
The 314px panel is readable; the final screenshot and browser record are retained.
No manual run, repair, approval or delivery was performed through this panel.

A consistent read-only production snapshot was streamed directly into a private test
clone: all 38 pending migrations (023–060) applied, all 76 historical tables retained
their original data, and replay verified 60 migrations without applying any again.
The clone was removed. This is not an off-host restore or a retained rollback backup.
Production app images/schema remain unchanged; the tested nginx configuration-only
repair restored healthy HTTP 200 and Canva remains authorized.

**Next is one supervised real-office job.** Google reviewer login is unconfigured;
the office domain and reviewer email have been requested. Real login credentials and
Google/Canva approval are not fabricated. Prepare a verified production recovery set
before controlled cutover, then run a real brief, human review and authorized delivery.
Historical adoption/reporting, approved permission policy and broader quality/recovery
gates remain open. No whole-app 10/10 claim or new completion ETA is made.

Earlier failures below remain retained; this section supersedes the earlier pending
local-qualification status and the earlier claim that production was wholly unchanged.


2026-09-27; ADR-107; migration 060; FR-047/048/049/050/064, NFR-006.

## Implemented and checked

Core schedules bounded hourly read-only Google checks against immutable publication
inputs. PostgreSQL serializes claims, stores exact input/result hashes, protects
history and applies current tenant/client membership. Interrupted claims expire
after two minutes with at most three attempts per hour. External reads compare
exact files/folder, complete permission pages, duplicates and stable full Sheet rows.
Operations displays scoped findings, timestamps, stale/unknown state and all details.
Reads never publish, repair, approve or send.

Focused final: **72 passed, 0 failed, 1 opt-in skipped**, 9 files. Separate actual
SIGKILL drill: **8 passed**, including natural two-minute lease expiry, fresh-process
recovery and late-result refusal. Source build, **513 strict test roots**, lint
(962/1053 any ceiling; nine existing egress exceptions), zero-secret scan pass.

## Initial failures retained

The first database run had 6 failures/1 pass: JavaScript truncated a PostgreSQL
creation timestamp, making a publication appear newer than itself. The comparison
now uses database timestamps directly. The first provider/UI run passed 20 tests
but failed 4 UI tests because the test harness requires fake timers; corrected.
Earlier TypeScript build failures and their corrections are retained where available.

## Qualification still pending

Full regression, matching deployed candidate and browser checks follow this checkpoint.
No production migration, live Google inspection, human approval or requester message
has occurred. Missing approved permission baselines stay unverified; observed access
is never promoted into authorization. Historical migration, full reporting columns
and remaining retained-result recovery are not completed by this slice.

## Pilot priority

The user challenged the elapsed time and requested completion. Finish this coherent
slice, verify the running candidate, then prioritize one real approved job and fix
pilot blockers. Avoid another broad architecture cycle. Real reviewer login is not
configured in production or the isolated candidate (read-only container check on
2026-09-27). Office domain/reviewer input is requested; no credentials were displayed.

## Pilot blockers found and corrected

The first full regression had **4234 passed, 1 failed, 60 skipped**. The concurrent
100-task fixture demanded immediate Sheet completion while other tasks inserted
rows. Row movement correctly refused inconsistent readback. The adapter now retries
only that read up to three times within its deadline. Continuous movement remains
unconfirmed. The simulation then reconciles the same pending receipts after each
batch answers: 100/100 complete, exactly 300 uploaded files and one row per task.
The first bounded-read-only correction reached 96/100; the final protocol tests plus
explicit reconciliation pass 48 tests/3 files. This synthetic fixture is not a human
pilot, Canva quality evidence or a real-office latency measurement.

The isolated full-app rehearsal passed before the final read refinement: 63 invariants,
1 selected scenario, 43 unselected; external services simulated. First rehearsal
refused an image-label mismatch because the manifest commit finished during build;
rerun used stable source 76e1e592. Fresh final-correction qualification follows.

A read-only production check also found HTTP 502 despite healthy Core: nginx cached
172.20.0.8 while Core moved to 172.20.0.7. Validated graceful reload restored HTTP 200.
A disposable network reproduced the old failure and proved dynamic DNS recovery for
Core and Desk at changed IPs without proxy restart (8 checks). The exact tested
configuration was validated and gracefully reloaded in production. App images, data,
flags and schema were not upgraded. nginx 1.27.5 supports the existing-image fix.
Reference: https://nginx.org/en/docs/http/ngx_http_upstream_module.html#server

The real nginx private-file delivery regression passes six checks after its fixture
was updated to a disposable user-defined Docker network (required for Docker's
embedded resolver). The initial default-bridge fixture failure is retained. Final
production readback: HTTP 200 healthy; Canva configured, authorized and active.
Google reviewer login remains unconfigured; the older production app does not expose
the newer auth-providers endpoint.
