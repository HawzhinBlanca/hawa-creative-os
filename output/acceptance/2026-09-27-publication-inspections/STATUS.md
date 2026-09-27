# Scheduled Google publication inspections — local qualification

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
