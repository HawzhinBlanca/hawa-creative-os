# R10 — Legacy delivery cutover pin

**Date:** 2026-09-25. **Status:** in progress. **Branch:** `codex/research-grade-design-system`. **Decision:** ADR-052. **Requirements exercised:** FR-060, FR-061, FR-070, NFR-003, NFR-013. Linked contracts: `docs/10_WORKFLOW_RELIABILITY.md`, `docs/14_SECURITY_THREAT_MODEL.md`, `MASTER_SPEC.md`; earlier slice design in `output/plans/2026-09-24-architecture-programme/PHASE2_DESIGN.md`.

## Finding and local change

An approved legacy task with no publication was assigned its delivery executor by the live `HAWA_LIFECYCLE_CHATS` setting when the operator pressed Deliver. An old request could cross to Restate after enrolment; a new enrolled request could cross to Core after a rollback. Only tasks with an already-started publication had a durable executor. The R10 acceptance rule requires old requests to finish on their original executor.

Migration 031 adds an immutable `tasks.delivery_executor_pin`; historical tasks default to `core`. A new Telegram task samples chat enrolment at creation. A revision, answer, reformat or reference task inherits the predecessor's pin after checking tenant, platform, chat and client scope; contradictory or missing predecessor links fail closed. The lifecycle projection pins its own new tasks to Restate and refuses to claim a Core predecessor. Replaying the same intake event returns the original task and pin. The publish route uses the stored pin before the first effect. A recorded publication or Core requester-file command retains its owner, including an in-flight historical Restate publication whose migrated task row defaults to `core`. The direct Core publisher and the workflow claim both check the stored choice before taking external effects.

## Verification

The disposable local PostgreSQL databases were rebuilt because a previous migration 030 checksum did not match this checkout. Versioned migration 031 applied to both. Focused cutover, intake and schema checks passed **4 files / 33 tests**; the new tests cover both chat-flag directions, first Deliver, direct Core refusal, idempotent replay, immutable pin, revision/answer/reference inheritance and scope refusal. TypeScript and tests typecheck passed. The first broad source run found **5 fixture failures** in three files: tests had linked revisions to a different random chat or client. Those fixtures were corrected to represent one request chain; the affected **3 files / 31 tests** passed. The corrected broad source run passed **421 files / 3,221 tests**, with **4 files / 48 tests skipped**, excluding only the manifest-dependent release-gate file. Lint passed with no new direct provider egress and the security scan found zero secrets in committable files. Exact-candidate sealing checks are recorded after the source commit.

## Remaining R10 acceptance work

This change pins legacy slice-2.2 delivery. It does not complete ChatInbox routing of an old request through a flag transition, including callback updates and late answers; it currently refuses a lifecycle projection that tries to claim a Core predecessor. No deployed canary, Restate backup/restore, clean-host recovery, real provider receipt, or full rollback drill was performed. `R10` stays in progress, and both production design flags stay off. These local checks do not establish a 10/10 production system.

## Sealed source checkpoint

Source and evidence commit `5a101e944700c4d5940e451516e22bf8404c0437` was sealed by `e78238f860873c05d11b6ed7e0564ec6d67a3770` with source-candidate manifest SHA-256 `bcf2966e2c7b5fd040800d04417130911e8d5945e7b30bd21a0e51c04e1d2a7b`. The clean exact-candidate suite passed **422 files / 3,227 tests**, with **4 files / 48 tests skipped**. The manifest verifier passed; six release-gate refusal controls passed separately; blueprint validation passed **779 checks / 0 warnings / 0 failures**. The admission assessor returned `UNQUALIFIED_ENGINEERING`, with Gates A–H each `NOT_RUN_DEPLOYMENT_REQUIRED`. The manifest records migration 031, unbuilt components and both design flags off. This is a source checkpoint, not a deployed release.

## Single-node Restate backup slice (ADR-053; 2026-09-25)

The existing nightly job verifies and archives PostgreSQL and the file store, but not the Restate data volume. The monthly drill also restores only those two stores. This leaves in-flight invocation journals and timers outside the recoverable set. ADR-053 adds a guarded, opt-in full-volume cold copy for the fixed production Restate service. Its default is read-only preflight. `--apply` checks a digest-pinned local helper, an encryption key, the volume/container, and agreement between Core and PostgreSQL on the persisted Telegram switch. It pauses intake, drains for at most five minutes, stops Restate, archives the whole volume, rejects unsafe tar paths or a missing node, verifies encrypted round-trip and hashes, restarts Restate to health, and publishes the manifest after recovery. A separately derived key authenticates its manifest and ciphertext digest. The nightly and monthly scripts integrate the opt-in archive and later independent stored-ciphertext check.

Local failure-path controls cover successful encrypted publication, archive failure after stop, failed recovery retaining the intake pause, preservation of an already-paused switch, stale Core/PostgreSQL disagreement before stop, overlapping backup refusal, helper pin refusal, unsafe or wrong-node tar, ciphertext tampering and manifest tampering. The existing PostgreSQL/blob backup regression passed **1 file / 9 tests**. The new Python controls passed **8 tests**; shell syntax and diff checks passed. A valid full-volume tar can contain safe metadata outside the named node directory, but it must contain at least one file under that node. No live `--apply`, clean-host Restate restore, off-host durability, RPO/RTO measurement or combined-store reconciliation was performed.

The broad source suite, excluding the manifest-dependent release-gate file, passed **421 files / 3,221 tests**, with **4 files / 48 tests skipped**. Workspace and test TypeScript, lint and the zero-secret scan passed. The first blueprint run correctly failed on stale package hashes after the documentation changes; the package was refreshed before sealing. The sandbox initially refused the local `tsx` IPC socket for TypeScript/lint, so those checks were rerun with the required local permission and passed. These setup failures were not code failures.

**Blocking safety gap:** Core's kill-switch API has no expected-revision conditional release. A concurrent operator toggle during a backup could be overwritten. The new backup flag remains off and the runbook prohibits unattended enablement until this is fenced. The monthly Restate check verifies stored bytes, not a booted/restored node. R10 remains **in progress**; no 10/10 or production recovery claim follows from this slice.

This paragraph records the ADR-053 checkpoint. The ADR-054 local slice below addresses the switch race; clean-host recovery and production qualification remain open.

## Sealed Restate-backup checkpoint

Source and evidence commit `bc3f0b3f8b9badff78487e4faf1bb1d89be2e0d6` was sealed by `ed8b31ab9faee3086c7a5bf63f024adaafc08147` with source-candidate manifest SHA-256 `20596534010acbf68d022cefe1cb651c179442eb38624ddfe80c67c079f6e229`. The exact clean suite passed **422 files / 3,227 tests**, with **4 files / 48 tests skipped**. The Python failure-path suite passed **8 tests**; the existing backup integration passed **9 tests**. Workspace/test typecheck, lint, the zero-secret scan, blueprint **781/0/0**, release-manifest verification, six release-gate controls and the corrupted-manifest refusal drill passed. The assessor returned `UNQUALIFIED_ENGINEERING`; Gates A–H each returned `NOT_RUN_DEPLOYMENT_REQUIRED`. The manifest still records unbuilt components and both design flags off. This is a local engineering checkpoint, not deployed recovery evidence.

## Conditional intake-switch release (ADR-054; 2026-09-25)

The ADR-053 checkpoint's concurrent-operator safety gap was real: its post-restart toggle blindly enabled Telegram. ADR-054 gives every persisted switch write a fresh opaque `changeTag` and lets a conditional toggle update the row only when that exact tag is still current. The backup retains the tag returned by its own pause and supplies it to release. A newer operator toggle, even one that keeps the channel paused, changes the tag; the backup's release conflicts and publishes no success manifest. Existing switch rows acquire a tag on their next ordinary write. A pending unsaved local switch decision also blocks a conditional write.

Disposable PostgreSQL tests passed **1 file / 16 tests**, including a non-office principal refused before write, stale-release refusal, and two Core instances using separate database handles that race to consume one revision. The backup's local failure-path suite passed **9 tests**, including an operator rethrow during archive capture. Workspace/test TypeScript passed. This is a local concurrency proof; no production switch transition, full volume restore, paired snapshot set, off-host durability or measured RPO/RTO was performed. The unattended flag remains off pending an isolated clean-host rehearsal and operational qualification, and R10 remains **in progress**.

## Sealed conditional-switch checkpoint

Source and evidence commit `512e108dac15bb40c8b51e772b76f903cb63f138` was sealed by `47bfbc6bf9436dc7cf87aeb0b23516110edc4793` with source-candidate manifest SHA-256 `e00ed1b982a5a9d67cb7090cbf71d519678379e0b97deadce43996cddc8d1a53`. The exact clean suite passed **422 files / 3,230 tests**, with **4 files / 48 tests skipped**. The focused PostgreSQL switch suite passed **16 tests**, and the Python backup controls passed **9 tests**. Typecheck, lint, zero-secret scan, blueprint **783/0/0**, manifest verification, six release-gate controls and the corrupted-manifest refusal drill passed. An earlier TypeScript run caught an optional-role type at the new authorization check; it was corrected before the seal. The assessor returned `UNQUALIFIED_ENGINEERING`; Gates A–H each returned `NOT_RUN_DEPLOYMENT_REQUIRED`. The manifest still records unbuilt components and both design flags off. No live Restate archive or clean-host replay was performed.

## Paired nightly recovery set (ADR-055; 2026-09-25)

The prior monthly drill restored its newest PostgreSQL dump but verified whichever Restate archive happened to be newest. A missed Restate night or manual archive could therefore produce a green archive check for the wrong recovery set. The opt-in nightly now passes its dump timestamp to the Restate command. Before pausing intake, it requires the same-night encrypted dump, checksum and blob manifest; after the encrypted Restate volume publishes, it signs a pair manifest binding exact names and SHA-256 hashes. It rechecks the database/file inputs after capture, and refuses an existing pair before contacting Docker. The monthly drill selects the pair from its selected dump timestamp and verifies all three stored members, including a full Restate decrypt/check. Archive pruning now waits for successful pair publication, preserving previous dumps and blob packs if the new Restate capture fails.

Local Python controls passed **15 tests**. They cover the verification CLI, successful binding, unrelated newer archive non-substitution, missing/changed database or blob inputs before pause, changes during capture, an existing pair, later tampering and the pre-existing restart/switch failure paths. The isolated PostgreSQL/blob shell regression passed **11 tests**, including an opted-in drill refusing an unpaired dump despite a newer Restate manifest and a failed Restate capture preserving previous archived sets. Shell syntax and whitespace checks passed. An added Python test initially failed because a changed dump surfaced its checksum error instead of the intended capture-change error; the error was contextualized and the full focused suite passed afterward.

The broad source suite passed **421 files / 3,226 tests**, with **4 files / 48 tests skipped**, excluding only the manifest-dependent release-gate file until this source commit is sealed. Workspace and test TypeScript, lint, the zero-secret scan and blueprint **785/0/0** passed. This source run is local and synthetic; it is not deployed recovery evidence.

This is archive identity and integrity evidence, not cross-store atomicity. The latest incomplete dump deliberately fails the monthly drill; recovery may use an older complete set. Restate archive retention, clean-host boot and journal replay, reconciliation of effects across the PostgreSQL/Restate capture gap, off-host durability, production schedule, and measured RPO/RTO remain open. The unattended Restate flag and both design flags stay off. R10 remains **in progress**.

## Sealed paired-backup checkpoint

Source and evidence commit `95c91d38a1c9384001efb61aa1818d78fb622deb` was sealed by `d202118` with source-candidate manifest SHA-256 `80f9de24babce1b1374107b9548b820f99374f47133c2129fcbb06cc529e6ada`. The exact clean suite passed **422 files / 3,232 tests**, with **4 files / 48 tests skipped**. The focused Python suite passed **15 tests**, isolated PostgreSQL/blob backup regression **11 tests**, and separate release-gate refusal suite **6 tests**. Workspace/test typecheck, lint, zero-secret scan, blueprint **785/0/0** and release-manifest verification passed. The manifest records unbuilt components and both design flags off. The assessor returned `UNQUALIFIED_ENGINEERING`; Gates A–H each returned `NOT_RUN_DEPLOYMENT_REQUIRED`. This is source and local recovery-set evidence, not a production Restate backup, clean-host restore or 10/10 admission.

## Bounded paired recovery-set retention (ADR-056; 2026-09-26)

The paired-backup checkpoint still pruned encrypted database dumps by newest file while leaving paired Restate ciphertext, manifests and pair files forever. Failed database-only nights could consume the dump slots. ADR-056 makes retention count complete authenticated pairs, not merely dumps. It preserves the newest incomplete dump for investigation, keeps migration-era database-only copies until enough pairs have accumulated, protects a set selected by a concurrent drill for at least 24 hours, and checks the newest pair's stored hashes before retiring older sets. Under the archive lock it checks every deletion target's file identity, prunes an expired pair's dump/checksum and Restate members together, then lets the existing blob-manifest/pack collector release unneeded file packs. An interrupted prune leaves the signed pair last so the next run can finish. Manual or otherwise unpaired Restate archives are reported but remain for operator review; stale incomplete `.part` files older than 24 hours are removed.

The opt-in and post-opt-in nightly path now uses this policy even if the Restate flag is later turned off. It requires the archive encryption key **before** any dump or off-host copy when a pair exists or the opt-in is on. This closes a plain-dump copy that could otherwise occur before retention failed on a missing key. A local Python suite passed **25 tests** across backup and retention controls. The isolated PostgreSQL/blob shell suite passed **12 tests**, including a flag-off night preserving an older paired set and missing-key refusal before archive changes. Shell syntax and diff checks passed. The first retention run had one assertion failure because the receipt listed expired unpaired dumps newest-first; the receipt was made oldest-first, then the focused suite passed. No production archive was pruned.

The broad source suite passed **421 files / 3,227 tests**, with **4 files / 48 tests skipped**, excluding only the manifest-dependent release-gate file until the source is committed. Workspace and test typecheck, lint and the zero-secret scan passed. Blueprint validation passed **787 checks / 0 warnings / 0 failures** after refreshing the package manifest. These are local source checks; exact-candidate sealing follows below.

This is a local bounded policy for scheduled paired sets. Unpaired manual/forensic Restate archives still require capacity monitoring and staffed disposal; production retention observation, off-host durability, clean-host replay, cross-store effect reconciliation and measured RPO/RTO remain unqualified. R10 stays **in progress**, and unattended Restate backup remains off.

## Sealed paired-retention checkpoint

Source and evidence commit `c9313dd7976addcc2aecf06e313ede0be15fea29` was sealed by `ab51f568c9c825bd996d33839bf56690de3095b3` with source-candidate manifest SHA-256 `00865e9f3c6af2075d07912b775d21226419ad6560334964b8d3156a44130bc3`. The clean exact suite passed **422 files / 3,233 tests**, with **4 files / 48 tests skipped**. The Python backup and retention suite passed **25 tests**; isolated PostgreSQL/blob backup integration passed **12 tests**; the separate release-gate refusal suite passed **6 tests**. Workspace/test typecheck, lint, zero-secret scan, blueprint **787/0/0** and release-manifest verification passed. The manifest still records unbuilt components and both design flags off. The assessor returned `UNQUALIFIED_ENGINEERING`; Gates A–H each returned `NOT_RUN_DEPLOYMENT_REQUIRED`. No production archive was pruned and no clean-host Restate restore or measured recovery objective was proved.

## Restate drain-query content negotiation (2026-09-26)

An isolated Restate 1.7.10 container returned binary data to the backup's `POST /query` request because it sent only `Content-Type: application/json` and did not ask for a JSON response. The backup's `response.json()` would fail before draining, so the opt-in cold archive could not complete against that server. A red-before live probe executed the exact JavaScript query with the old headers and observed failure; the same probe with `Accept: application/json` returned `running=0`. The backup now requests JSON explicitly, matching the existing Core health probe. A local loopback wire-contract test exercises both response types and the production query body; the Python backup/retention suite passes **26 tests**. The first live probe also received a transient HTTP 500 immediately after a fresh node's health check; a bounded retry after SQL startup showed the actual content-negotiation failure and fix. All disposable containers and volumes were removed. This is a local compatibility repair, not a production archive, clean-host journal replay or R10 admission.

The first Python run could not bind the loopback test server under the filesystem sandbox (`PermissionError`); the same suite was rerun with local socket permission and passed. The broad source suite passed **421 files / 3,227 tests**, with **4 files / 48 tests skipped**, excluding only the manifest-dependent release-gate file until source sealing. Workspace/test typecheck, lint, zero-secret scan and blueprint **787/0/0** passed. Exact-candidate results follow after the source is committed.

## Sealed Restate admin-query compatibility checkpoint

Source and evidence commit `3e165d9f89d629c480743859320b8ed40f06b50a` was sealed by `6a0b4c0e031aab6bc74514eed6b27fd9a3f08ff2` with source-candidate manifest SHA-256 `17db31c32bb6332b2d51feff896bc17df8d7cd95cf3260dfba855e58e1f4b4c5`. The clean exact suite passed **422 files / 3,233 tests**, with **4 files / 48 tests skipped**. The focused Python backup/retention suite passed **26 tests**; the disposable Restate 1.7.10 red-before/green-after wire probe passed. Workspace/test typecheck, lint, zero-secret scan, blueprint **787/0/0**, release-manifest verification and **6** separate release-gate refusal controls passed. The manifest records both design flags off. The assessor returned `UNQUALIFIED_ENGINEERING`; Gates A–H each returned `NOT_RUN_DEPLOYMENT_REQUIRED`. The production app still runs build `1c1316d`, so this local fix has not been deployed or exercised on its live archive.


## 2026-09-26 — Isolated encrypted archive boot and state readback (ADR-057)

`infra/backup/restate_restore_rehearsal.py` verifies an explicit authenticated pair, matching Compose digest and locally available immutable server image. Apply copies the archive under its shared retention lock, decrypts and checks the full tar, then extracts into a newly labeled disposable volume and boots with no network or published ports. Its JSON receipt distinguishes an isolated boot from journal or external-effect recovery. Cleanup finds resources by the private run label even when Docker created them but the CLI timed out; unsafe/duplicate tar members are refused before Docker. SIGTERM also attempts cleanup.

The focused Python backup, retention and restore controls passed **33 tests**. Negative cases cover wrong keys, damaged pair/configuration, mismatched image, archive lock contention, traversal/link/FIFO/duplicate members, malformed SQL, interruptions, failures after resource creation, and cleanup failure. The existing isolated PostgreSQL/blob integration passed **1 file / 12 tests**. The new Python tool does not change TypeScript application behavior; the full application suite was not rerun for this slice, and its prior sealed result remains historical.

The reproducible `infra/backup/drill_restate_restore.py` created an offline synthetic Restate 1.7.10 node, saved a Virtual Object marker, stopped the node, encrypted/authenticated its full **51-file / 665,600-byte** archive, and ran both plan and apply on the exact image ID. The restored node reported **1 invocation**, and its **1 durable state row** matched the source. The sanitized receipt is `R10_RESTORE_DRILL.json`. No live volume, production key or client data was read; a final label query found **zero** remaining drill containers and volumes.

Initial fixture runs failed: the HTTP/1.1 worker required `use_http_11: true` during registration, and Restate 1.7.10 exposes its state as table `state`, not `sys_state`. The corrected fixture passed; failed runs cleaned their temporary resources. A direct baseline counterexample also showed that the previous tar inspector accepted two aliases of the same normalized journal path; the new inspector refused them. All seven restore-specific tests passed after correcting the negative fixture's file count so it tests the unsafe path itself, rather than an unrelated count mismatch.

**Limits:** this is restored synthetic state on the same host. It does not prove a clean-host recovery, a pending invocation's journal replay, PostgreSQL/Restate capture-gap reconciliation, external send/Drive/Sheet idempotency after restore, off-host durability, or measured production RPO/RTO. The recorded Compose hash is not a full effective-configuration snapshot. R10 remains **in progress**; production build and flags remain unchanged.


## 2026-09-27 — Encrypted PostgreSQL PITR (ADR-079)

Nightly logical dumps did not provide continuous WAL or prove the 15-minute database
RPO. The optional candidate now uses the cached PostgreSQL 17.11/pgvector base plus
pgBackRest 2.59.1, both checked during image build and recorded by immutable image ID.
A private file supplies the repository key; synchronous WAL archival uses a 60-second
archive timeout. The production Compose file and running services are unchanged.

`R10_PITR_PROOF.json` records a real encrypted physical backup and PITR into fresh,
offline volumes. A task committed after the base backup is present, a later task is
absent, **86 application tables and 133 RLS policies match**, and the server has
finished recovery and promoted. The runtime role sees 7 permitted tasks and 0 across
tenants. Natural WAL archival took **59.573s**; restore plus application/RLS
verification took **6.632s**. Wrong-key metadata refusal and missing-WAL target
refusal pass; a separate label query confirms zero leftover containers or volumes.
These timings describe this synthetic same-host fixture, not production RPO/RTO.

All **43 Python backup/retention/restore tests pass**. The optional Compose overlay
renders with synthetic values and preserves existing database/init mounts. It
adds no runtime application change; the prior 3,634-pass / 59-skip app regression
is historical and was not rerun for this infrastructure slice. Source seal and
final package checks follow in the checkpoint below.

Failed-first evidence is retained in the receipt. The first restore returned 75
with hidden stdout; its original cause is unconfirmed. Subsequent strict wrong-key
controls exposed pgBackRest's metadata FormatError. Success with the correct key
now precedes that control, and unrelated restore errors cannot qualify it. Parser
payloads are suppressed. Readiness waits for promotion because a hot standby can
answer SQL before reaching its target. The initial Python run also had one local
socket permission error; the permitted rerun passed.

**R10 remains in progress.** Separate-machine/off-host recovery, pending Restate
journal replay, database/file/workflow capture-gap reconciliation, restored external
effect deduplication and production activation remain unproved. Production is
unchanged. Real Canva/human review, supervised delivery and retrieval/model-quality
measurements remain separate app completion gates.

### Sealed isolated-PITR checkpoint

Source `c02ed26`, tested seal `de5ad14`: all seven qualified source hashes match
the sealed checkout. Release-manifest verification and blueprint **891/0/0** pass;
the security scan finds zero secrets and the diff check passes. The real drill and
43-test backup suite above qualify this unchanged source. No full application
regression, production activation or full-system recovery is claimed for this slice.

## Coordinated application recovery implementation (ADR-080, 2026-09-27)

The existing nightly pair does not freeze every writer throughout its capture gap.
The new candidate-only cold-capture helper stops Core, workers, Restate and PostgreSQL,
authenticates/encrypts each store, restores fresh volumes at observed immutable images,
and verifies all rows/RLS, complete file contents, registered blob hashes and pending
Delivery identity before writer admission. Original stores are retained during the
rehearsal. External fakes remain alive so restore cannot erase their side effects.

The full-app source scenario now optionally invokes this helper after a Drive effect
and after an unconfirmed Telegram send. Qualification must prove one completed
publication and sheet row, adoption of the original Drive file, no repeated Telegram
file, and one uncertain-send office alert. These are intended checks, not results:
the actual deployed rehearsal is pending. The Python backup suite passes **50 tests**
(seven new recovery refusal controls); the candidate harness typecheck passes.
Production and unattended Restate backup remain unchanged; R10 remains in progress.

The restored uncertain send must remain in requester-send reconciliation. The
rehearsal records no automatic completion: it checks operator refusal, then uses
an explicit synthetic administrator observation of the original fake-chat message
IDs to settle the request. The observation and its replay must cause no new send.
This exercises the existing ADR-046 contract and does not qualify real staff review.

## Qualified coordinated candidate (ADR-080, 2026-09-27)

Source `a3de8c3` passes **57/57 deployed checks** with PostgreSQL durability flags on.
The two matched cold captures restore all three stores into fresh volumes at exact
image IDs; each matches **86 tables, 133 RLS policies and 4 registered blob hashes**
before Core/worker resume. The surviving external fake ledgers prove the same Drive
file is adopted, the uncertain Telegram file is not resent, one office uncertainty
alert is emitted, and one publication/Sheet row completes. The same pending Delivery
invocation/deployment survives both restores. Ordinary operator settlement is
refused; explicit synthetic administrator observation and replay cause no new sends.
The detailed result is `R10_COORDINATED_RESTORE_PROOF.json`.

Earlier runs failed after successful store validation: the first reported a fetch
failure after a synchronous restore driver (precise transport cause unconfirmed);
the second counted an earlier review notice as an uncertainty alert. The driver is
now asynchronous and the assertion targets uncertainty alerts. A continuation probe
proved settlement before the final fresh run; expected final revision is 9 because
staff settlement is an extra transition. Both failed attempts remain in the proof.

A presence-only runtime probe found `.run/chaos.env` and the private run directory
inside the previous synthetic Core image. Git ignore did not constrain Docker's
package copy. `.dockerignore` now excludes all `.run` directories and backup
snapshots; actual Core and worker filesystem checks pass. No credential contents
were read, and neither historical production images nor historical image-cache
removal is claimed. This is an NFR-006 build-boundary correction.

Focused validation passes **50 Python backup tests**, **11 fake-wire tests**,
harness TypeScript, lint, security and blueprint **895/0/0**. Lint first hit a
sandbox IPC refusal and passed with local socket permission. The first privacy-fix
commit was refused by the blueprint hook until required manifests were refreshed;
the hook was preserved. The selected chaos test passes; 43 unselected scenarios
are explicitly skipped. The prior full 3,634-test application regression was not
rerun for these infrastructure/harness changes.

No helper containers or private archive directories remain. Original and both
restored three-volume store sets are intentionally retained by `--keep`. Startup
and validation took 7.390s and 7.347s after archive extraction; these are not full
restore timings or production RTO. Store receipts deliberately state
`applicationReplayProved: false`: the subsequent scenario provides replay proof.
Production and automatic Restate backup admission are unchanged. Independent-host,
off-host, capture-gap, real-provider and human acceptance remain open; R10 remains
in progress.

### Coordinated-recovery source seal

Candidate `a3de8c3`, evidence `ccbd005`, tested seal `10a8087`: all 11 qualified
source hashes match the clean sealed checkout; release-manifest verification,
security (zero secrets), blueprint **895/0/0** and diff checks pass. The actual
57-check candidate above provides the deployed synthetic proof. No full app-suite
rerun, independent-host recovery, real-provider/human acceptance or production
activation is implied by this source seal.

## Nightly archive integrity and monitoring (ADR-081, 2026-09-27)

The actual backup integration reproduced two false successes: a deleted retained
pack still returned zero, and a failed synthetic `gsutil` command still returned
zero. A shared archive reader now verifies all indexed required packs, including
old ones, before publishing a new file manifest and the final dump. Unsafe tar
members are never extracted directly: required files are privately staged, hashed,
and published only after the complete selected set passes. Missing or corrupt
bytes prevent new archive publication, pruning and collection.

An inherited, inode- and mode-checked descriptor holds the existing archive lock
across the whole nightly process; restores hold it shared, and nested Restate
capture/retention reuse the owner's lock. The tested busy-lock path preserves
snapshots, scratch databases and an older active workspace. Workspaces are unique;
process failure and SIGKILL release the lock. No stale PID-file takeover is used.
Incomplete cloud transport is refused before dump/transport; no off-host delivery
is invented. Same-directory rename publishes verified copies, with the dump last.

The watchdog previously used local dump mtime, which could look fresh after archive
failure. Its actual status command now observes the completed nightly receipt and
capture time, with matching local size/checksum metadata. Tests cover success,
failed archive despite a fresh local dump, touching an old dump, missing/mismatched
metadata, malformed/future receipts and a separately reported GC warning. It does
not periodically rehash the whole archive or qualify off-host durability.

Final qualification passes **71 Python backup controls and 16 database-backed
lifecycle tests**, zero skipped; test TypeScript and shell syntax pass. The first
lock test run had one harness failure: an extra Python subprocess dropped the
inherited descriptor; passing it explicitly models the real shell boundary.
`R10_ARCHIVE_INTEGRITY_PROOF.json` records exact source hashes and failed-first
history. The earlier 3,634-pass/59-skip app regression is historical; no application
runtime source changed and it was not rerun for this host-script slice.

The loaded nightly backup and watchdog agents point to this checkout, so the next
job invocation uses these source changes. Their definitions were not changed; app
services were not restarted; tests used only temporary archives and isolated DB
clones. No production backup, restore or notification command was launched.
Separate-host/off-host recovery, database/Restate capture-gap repair, production
RPO/RTO, real Canva/human/live acceptance and retrieval/model measurements remain
open. The legacy database archive format is unchanged; file-content checking adds
no new authenticity claim for an unpaired historical database dump.

### Initial archive-integrity source seal

Source `e2b6612`, tested seal `de36c82`: all 12 qualified source hashes match the
clean checkout; release-manifest verification, security (zero secrets), blueprint
**899/0/0**, shell syntax and test TypeScript pass. The 71 Python/15 DB lifecycle
results qualify this exact host-script source. Source sealing adds no production
restore, independent-host/off-host or real-provider/human acceptance claim.

### Checked checksum failure follow-up

A bounded probe of the previously committed publication function made every
checksum command exit 2. The old function compared the two empty outputs and
published the archive with exit 0; the corrected function returned 1 and published
nothing. Source and copy hashes now require successful commands and a valid digest
before equality. The full isolated lifecycle passes **16 tests**, including a
mid-publication checksum failure that leaves the previous archive set unchanged
and the watchdog unhealthy. Test types and shell syntax pass. Python source is
unchanged from the passing 71-test run. The final seal below supersedes the
15-test source qualification for this additional refusal control.
