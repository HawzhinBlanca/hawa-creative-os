# Immutable publication expectations — local implementation checkpoint

2026-09-27; ADR-106 / migration 059; FR-047, FR-048, FR-049 and FR-050 prerequisite.

## Delivered

- Original approval/revision/scope, file identities/names/hashes/sizes, destinations and timestamp are frozen in PostgreSQL before publishing. A new Core instance uses the original input after DNA changes.
- The Google adapter durably binds exact Sheet values and metadata before its first Sheets call. An originally absent Sheet can be configured once. Its link is checked against the first artifact's reserved Drive ID; discovered uploads verify or adopt that same reservation.
- SQL hashes immutable expectations; tenant/client RLS applies current membership. Conflicting Drive/Sheet receipts are refused. Canva export IDs have a distinct publication artifact column, preserving the older artifacts-table foreign key.
- Delayed pending receipts preserve evidence only for the same confirmed publication. New failed observations and different packages do not inherit a synced state or old observed hashes.
- Unfinished historical protocol-0 publications stay held; current DNA is not used to fabricate original inputs.

## Verification

Final affected suites: **2390 passed, 0 failed, 15 skipped**; 268 passing/5 skipped files, 92.20 seconds. This covers all Core, integrations and database tests, including the existing Sheet process-kill proof. Targeted correction group: 61 passed/8 files; earlier focused group 38/3 overlaps and is not additive.

Source build, all **509 strict test roots**, lint (962/1053 any ceiling; nine existing egress exceptions), zero-secret scan and 11-pattern scanner self-test pass. New expectation recovery uses fresh Core/publisher instances and an injected interruption after committed Sheet binding; no new actual Core SIGKILL drill is claimed for ADR-106.

## Failure history

The original destination-change retry failed against its stored Drive receipt. The first implementation run exposed that Canva export IDs do not belong in the older artifacts foreign key (25 passed/5 failed). The receipt regression reproduced lost metadata after a delayed pending reply. Added SQL authority then correctly rejected an old fixture that fabricated a destination for a bound publication (37 passed/1 failed); the historical receipt fixture was separated. The broader run had 2378 passed/12 failed/15 skipped: per-row permission helpers, migration inventories, fabricated Drive folder receipts and a test mutating frozen expected hashes were corrected. Final rerun passes. The initial lint IPC sandbox refusal is preserved. Connection credentials in retained test logs are redacted; outcomes remain intact.

## Limits

No new full repository regression/release seal, deployed image, production migration or live Google call was made. The last fully checked release remains ADR-104 (4169 passed/0 failed/59 skipped on its own source); the isolated runtime remains 1f07c9b3.

Scheduled external Drive/Sheets observations, scoped staff resolution and historical migration, full reporting columns and actual permission baselines remain open. Remaining result recovery, real Workspace/model/Telegram/Canva, pending native after-preview approval, human multilingual/design and held-out quality evaluation, independent-host restore/monitor installation and controlled rollout remain whole-app gates.
