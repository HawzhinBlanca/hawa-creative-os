# Findings ledger — 2026-09-27, baseline `59150ca`

> **History only (2026-09-28, ADR-127).** A ledger of `studio-v2` at `59150ca`, kept as history on
> `codex/research-grade-design-system`, the mainline since the owner's decision of 2026-09-28, where
> studio-v2's RequestLifecycle (wave 7) was superseded by the mainline's own. Items are not
> re-verified against the mainline.

This ledger re-verifies every item in `output/audits/2026-09-21-engineering-rank-audit/FINDINGS.md` against `59150ca`, and adds new findings.

**Status values:** FIXED · PARTIAL (partially fixed) · OPEN · N/D (cannot determine).

**Basis:** code reading, unless marked:
- *(checked)*: re-read by the orchestrator;
- *(reproduced)*: executed.

**IDs:**
- Items the 21 Sept verifier added with no ID are labelled `V:`.
- New findings are labelled `N-<area>-<n>`.
- The design-output defects had no IDs, so they are labelled D1–D9 in ledger order.

**Totals:** 187 re-verified rows (items raised by two slices are merged). 26 fixed, 78 partially fixed, 82 open, 1 undeterminable.

---

## A. Core API and security (score 5/10)

| ID | Sev | Status | Evidence at 59150ca |
|---|---|---|---|
| CORE-01 | high | PARTIAL | `services/client-dna-resolver.ts:28-36`: Postgres is read first and the Map is no longer seeded from fixtures. If the DB read fails, the resolver answers from the Map, so stale DNA can still pick the delivery destination. |
| CORE-02 | high | OPEN | `routes/revisions.routes.ts:143-213` still runs QA against an invented manifest, render and DNA (`byteSize: 12`, `tenant-default`), then writes `qc_runs` (218-232). A failed write is only logged. `decisions.routes.ts:206-224` trusts the newest such row. |
| CORE-03 | high | PARTIAL | No unauthenticated mutation remains. These routes are still registered directly on `app.*`: `system.routes.ts:48,49,61,62,563,594,617`, `canva.routes.ts:39`, the internal lifecycle and delivery routes, and `comparison.routes.ts:228-229`. No gate forbids this. |
| CORE-04 | med | OPEN | `routes/whatsapp.routes.ts:399` is a GET that changes state. The HMAC covers only `taskId` and `action`, never expires and accepts a 16-hex prefix (`outbound-notifier.ts:62-90`). A failed DB write is swallowed (324-326) and the page still says "approved". |
| CORE-05 / SEC-01 | med | PARTIAL | The token is now `randomBytes(32)` (`auth.routes.ts:164`). The allowlist still fails open (`:158`), and nothing calls the route. |
| CORE-06 | high | PARTIAL | Requests owned by RequestLifecycle are validated. Legacy `TaskRepository.transitionState` checks the version but has no legal-move table (`task.repository.ts:615-635`). Transition failures are only logged at `controls.routes.ts:110`, `whatsapp.routes.ts:324,372`, `task-pipeline.routes.ts:113` and `omnichannel-delivery.ts:509,543`. |
| CORE-07 / TS-03 | high | OPEN | No request schema anywhere. 57 of 73 `c.req.json()` calls use `.catch(() => ({}))`. |
| CORE-08 | high | PARTIAL | `index.ts:112-143` calls `server.close` on shutdown. It does not stop the poller or intervals or close the pool. SSE blocks `close`, so shutdown always ends in the forced `exit(1)` after 10 s. Compose sets no `stop_grace_period` and no `init`. |
| CORE-09 | high | PARTIAL | `app.ts` is 1,129 lines, but `createApp` still spans 122-1129 and holds auth, the session store and health. |
| CORE-10 | med | OPEN | `app.ts:893-896` mounts four prefixes. The nginx login limit covers only `= /v1/auth/session` (`nginx.conf:124`). |
| CORE-11 | med | PARTIAL | The ops views now read Postgres. Still open to any role: fault injection (`system.routes.ts:533-555`) and `/operations/slo/run` (410-429), which drives the real GooglePublisher with invented IDs (`testkit/src/slo-daemon.ts:268-301`). Simulators are still registered. |
| CORE-12 / SEC-07 | med | PARTIAL | The role header and test principals now need `CreateAppOptions` (`app.ts:449,481,531`). Test branches are still compiled in (`client-learning.routes.ts:97,101,243,270`). Still gated on NODE_ENV: stack traces (`app.ts:188-191`), unauthenticated WAHA without a secret (`whatsapp.routes.ts:49-58`) and the Telegram allowlist. Config is not validated at boot. |
| V: client lookups outside RLS | med | PARTIAL | The main lookups are scoped. The fallbacks at `clients.routes.ts:153,156,176` are not, and the RLS role defaults to `administrator` (139,168). |
| V: kill switch cosmetic | med | PARTIAL | The switch is persisted and enforced (`channel-kill-switches.ts`, `telegram-webhook.routes.ts:75`). `/operations/kill-switch` accepts any role and answers before the write (`system.routes.ts:517-531`). |
| V: ~40% of routes have no caller | med | OPEN | 708 routes in `test/fixtures/route-inventory.txt`, including simulators, fault injection, evals and migration samples. |
| V: status from error prose | med | OPEN | Status is picked by substring match at `decisions.routes.ts:335-341` and `clients.routes.ts:182,224,339`. About 20 handlers return raw `err.message`. |
| SEC-03 | high | OPEN | Identity is still three shared static keys (`app.ts:496-521`, `auth.routes.ts:48-77`), with a fixed `userId` per session. |
| SEC-02 | med | OPEN | Same as CORE-04. The `publish`, `phone` and `notes` query parameters are not signed (`whatsapp.routes.ts:238-270`). |
| SEC-04 | med | PARTIAL | `/ingress/unified` is fixed. `/ingress/promote` still puts `body.tenantId` and `body.userId` into the RLS context; see N-SEC-6. |
| SEC-05 | med | OPEN | About 21 role checks cover 86 mutating routes. `POST /clients/:id/dna` needs only a signed-in caller, so any role can rewrite the Drive and Sheets destinations (`clients.routes.ts:121-126`). The publish routes have no role check. |
| SEC-06 | low | PARTIAL | No unauthenticated mutation remains. CORS is still `*` (`app.ts:146-147`). |
| SEC-08 | med | PARTIAL | The token is in sessionStorage, with a fallback to localStorage (`desk/src/services/auth.ts:23-26`). Logout revokes the session. The CSP meta allows `connect-src http: https:`. nginx sends no CSP header. Core accepts `?access_token=` (`app.ts:425-435`). |
| SEC-09 | med | OPEN | No `read_only`, `cap_drop` or `no-new-privileges`. Only one image is pinned by digest. `deployment/docker-compose.yml` still exists. |
| SEC-10 | med | PARTIAL | The literal password is gone and rotation tooling exists. The scanner still ignores history (`security_scan.py:53-55`). |
| SEC-11 | low | PARTIAL | Key previews are admin-only. Public `/health` still returns probe error text, model config, funnel counts and the build commit (`app.ts:778-838`). The `includes('figma')` rule is still there (`:875`). |
| SEC-12 | low | OPEN | The suppression note says only the PNG logo reaches pptxgenjs. AI art and background images are passed too (`transfer-v2.ts:391`, `editable-transfer.ts:68`). CI does not run `pnpm audit`. |
| V: service worker caches API | med | PARTIAL | Binaries are no longer cached. `/v1/` JSON still is (`sw.js:136-150`), and `clearPwaCaches` is never called on sign-out. |
| V: minted approve link | med | PARTIAL | `POST /campaigns/:taskId/dispatch-review` still returns signed approve URLs to any role (`delivery.routes.ts:350-390`). |
| V: actor from literals | med | PARTIAL | `/publish` records `auth.userId`. `publish-omnichannel` records `'operator'` (`delivery.routes.ts:459`), and the WhatsApp link uses the unsigned `?phone=`. |
| V: substring allowlist | low | OPEN | `app.ts:871-876`. `system.routes.ts:563/594/617` skip `ensureSessionLoaded`. |

The 21 Sept status column says "kill-switch now requires administrator". That is true for `/waha/kill-switch` but not for `/operations/kill-switch` (`system.routes.ts:517-521`).

| New | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| N-SEC-1 | high | The request-body policy `deliver_approved_stored` skips the revision-binding, invalidation and QC checks and forces APPROVED, for any role. *(checked)* | `delivery.routes.ts:404-414,453`; `omnichannel-delivery.ts:193,365,379-380` | Allow it for administrators only, with a recorded reason, and keep the QC and pending-change checks. |
| N-SEC-2 | high | `publish-omnichannel` has no pending-change check, so it delivers a version the client asked to change. The WhatsApp `?publish=true` link takes the same path. | `delivery.routes.ts:394-470`; `whatsapp.routes.ts:264-270` | Call `changeBlockingDelivery` inside `deliverOmnichannel`. |
| N-SEC-3 | med | The approval QC gate is opt-in and fails open on a lookup error. | `decisions.routes.ts:233-241` | Always require a passing QC run; answer 503 when the lookup fails. |
| N-SEC-4 | med | The WhatsApp action link writes `tasks.state` on requests that RequestLifecycle owns. | `whatsapp.routes.ts:300-327,347-375` | Check `readTaskLifecycle` and forward to it, or refuse with 409. |
| N-SEC-5 | med | Any role can release an administrator's kill switch. | `system.routes.ts:517-531` | Require administrator and await `setKillSwitch`. |
| N-SEC-6 | med | `/ingress/promote` takes tenant, user and client from the body into RLS. A requester can pass the admin UUID and create tasks in another tenant or client. *(checked)* | `ingress.routes.ts:130-148` | Take identity from `auth` only, 403 on a mismatch, and check `can_access_client`. |
| N-SEC-7 | low | The public funnel route leaks DB errors, and signed-in callers can spam ops alerts. | `system.routes.ts:65-75`; `funnel-monitor.ts:119-149` | Require auth, alert only from a scheduled check with a cooldown, return a generic error. |
| N-SEC-8 | low | `HAWA_DEV_TOKEN` signs in as operator in production. | `auth.routes.ts:49,74` | Refuse it when `NODE_ENV=production`. |
| N-SEC-9 | low | Env files in the working directory override deployed secrets. | `index.ts:9-27`; `app.ts:26-35` | Load env files only outside production and never override existing variables. |
| N-SEC-10 | med | The SVG sanitizer is single-pass. `<svg><scr<script/>ipt>alert(1)</scr<script/>ipt></svg>` gives `<script>alert(1)</script>` with `ok:true`. *(reproduced)* | `packages/domain/src/sanitizer.ts:70-74`; `routes/assets.routes.ts:93` | Use a real XML parser plus an allowlist (DOMPurify SVG profile), or loop until stable, and reject any input that needed changes. |
| N-SEC-11 | low | The Desk SVG sanitizer allows `<style>`, which inside inline SVG can restyle the whole page. | `apps/desk/src/services/sanitizer.ts:23`; `VectorInspector.tsx:33` | Drop `style`, or render the SVG in `<img>` or a sandboxed iframe. |

## B. Database (6/10) and privacy (3.5/10)

| ID | Sev | Status | Evidence |
|---|---|---|---|
| DB-01 | high | FIXED | Invalidation is now an `approval.invalidated` task event. Approvals are insert-only (`revision.repository.ts:172-220,391`). |
| DB-02 | high | PARTIAL | With a DB the Maps are empty, and `transitionState` checks the version. Failures are still logged and the request carries on: `omnichannel-delivery.ts:543-545` uploads after a failed move to publishing, and `task-pipeline.routes.ts:113-126` returns 202. |
| DB-03 | med | PARTIAL | `inbox_events` got a `NULLS NOT DISTINCT` index (migration 020). `message_events` did not (`schema.sql:219`), and its insert is read-then-insert. |
| DB-04 | high | PARTIAL | The fallback to RAM is gone. Repositories still accept a raw handle, and `DesignStudioRepository.withClient` can run unscoped (`design-studio.repository.ts:198-209`). |
| DB-05 | high | FIXED | `recordSheetSync` is an upsert (`publication.repository.ts:239-253`). |
| DB-06 | high | PARTIAL | `db/03-grants.sql` exists and is mounted, but only runs on a fresh data directory. It is unversioned and grants blanket DML on the remaining tables. |
| DB-07 | med | FIXED | Pool error handlers and statement, idle and connect timeouts (`client.ts:23-37`). The outbox now does claim, act, record, with the claim checked before each side effect. |
| DB-08 | med | OPEN | `types.ts` has 3 phantom tables, leaves 39 of 77 tables untyped, and types bigint as `number`. |
| DB-09 | med | OPEN | 21 of 77 tables are never used, including `audit_events` and `model_invocations`. |
| DB-10 | med | OPEN | Unguarded `Number(task.version)+1` at `publication.repository.ts:128,307,375` and `revision.repository.ts:188,422`. The budget is a JSON read-modify-write. |
| DB-11 | med | PARTIAL | Migrations are found with `readdirSync`, with gap and checksum checks. `schema.sql`, `rls.sql` and grants sit outside the runner. `db:migrate` reports success without a DB (`migrate.ts:97-104`). |
| DB-12 | med | PARTIAL | 3 indexes added (migration 018). Reconciliation is still N+1 and unbounded. `selectAll` still pulls bytea. |
| DB-13 | med | PARTIAL | Health runs `SELECT 1`. Production still starts without `DATABASE_URL` (`index.ts:52`). |
| DB-14 | med | FIXED | Plaintext `.sql` dumps are no longer copied, and archive dumps expire after 30 days. |
| V: app role ALL/TRUNCATE | high | OPEN | No migration revokes the existing production grants. `PHASE0_EVIDENCE.md:139` records the drift. |
| V: RLS identity from body | med | OPEN | Narrowed to `/ingress/promote` (N-SEC-6). |
| V: spend under-count | med | PARTIAL | Parity cost now persists before a run finishes. The cap is still a JSON blob that can lose writes. |
| V: plaintext archive | med | FIXED | Same as DB-14. |
| P: staff directory in git | high | PARTIAL | The reference and OCR data is gone and history was re-rooted. `config/clients/kaae.dna.json:34-210` still lists 27 named people. |
| P: no deletion/retention | high | OPEN | Nothing reads `retention_policy`. There is no purge or export path. |
| P: ledger over-claims privacy | high | OPEN | `plans/traceability.csv:88` (NFR-007 "enforced and verified"). |
| P: egress policy dead | high | OPEN | Nothing loads `model_egress_policy`. The classifier (`telegram-classifier.ts:435-451`) sends text and images to OpenAI, and voice goes to Whisper (`voice-transcriber.ts:96`). |
| P: Verdana / OFL | high | PARTIAL | The Verdana files are out of git and the image installs msttcorefonts. There is no licence text for Cairo, Cinzel, Playfair Display or Plus Jakarta Sans, and none at all in `apps/desk/public/fonts`. |
| P: raw Telegram plaintext | med | OPEN | `chat-intake.ts:276`. `raw_payload_encrypted` is never set. |
| P: LICENSE_NOTICE / no LICENSE | med | OPEN | Unchanged. |
| P: no privacy notice / DPA | med | OPEN | None exists. |
| P: plaintext off-host dumps | med | PARTIAL | A fresh install has no key file, and `nightly_backup.sh:170-196` copies plaintext off-host without refusing. |
| P: output/evidence tracked | low | OPEN | 1,297 files tracked. |

| New | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| N-DB-1 | med | Reconciliation restores invalidated approvals. *(checked)* | `task-reconciliation.ts:101-108`; dead check at `omnichannel-delivery.ts:191` | Exclude approvals with an invalidation event, require the current revision, delete the dead check. |
| N-DB-2 | high | Test DBs never apply production grants. | `test-template.ts:61,88-95` | Apply `03-grants.sql` in `buildDatabase` and add it to the template hash. |
| N-DB-3 | low | Newer tables (studio, cutouts, comparison, `task_files`) check the tenant but not client membership. | migrations 013-015, 019; `design-studio.routes.ts:234` | Give them task-joined policies with `can_access_client`. |
| N-DB-4 | low | A `gs://` off-host copy fails silently. | `nightly_backup.sh:188-191` | Call `fail` when `gsutil` is missing or `cp` fails. |
| N-DB-5 | low | Backup encryption has no MAC, and the sidecar hash is stored in the same place. | `nightly_backup.sh:176,216`; `restate-nightly.sh:322` | Use `age` or `gpg`, or an HMAC with a separate key. |
| N-DB-6 | low | `tasks.client_id` can change at the DB level after retrieval, against the AGENTS.md invariant. | no trigger in the schema | Add a BEFORE UPDATE trigger once the task is past `routing`. |

## C. Durable workflows and the live chain (6.5/10)

Production facts: `HAWA_TELEGRAM_POLLER` defaults to `core`, and `HAWA_LIFECYCLE_CHATS` is empty. So production still runs Core's own path, and RequestLifecycle, DesignRun and Delivery serve flagged chats only.

| ID | Sev | Status | Evidence |
|---|---|---|---|
| DW-03 | high | PARTIAL | Drive is looked up before each upload, and a publish advisory lock prevents duplicates. The receipt ledger and the Sheets row map are in memory (`google-publisher.ts:51-53,321`). `drive_refs` are written after the whole publish, in a separate transaction. |
| DW-05 | high | FIXED | 12 attempts with jitter, about 4 h 20 min before a dead letter. Dead letters degrade health. |
| DW-01 | med | FIXED | Terminal errors now become TerminalError and end through `finish()`. |
| DW-02 | med | FIXED | The report step retries for 1 h, then falls back to the outbox. |
| DW-04 | med | PARTIAL | The Restate submit is timed and runs outside any transaction. Sheets and some bridge calls are still untimed, and they run under the publish lock. |
| DW-06 | med | FIXED | A `notify.published` handler exists (`outbox-consumer.ts:523-640`). |
| DW-07 | med | PARTIAL | The bridge separates a failure before the connection and passes on `retry_after`. The outbox path still uses regex classification and ignores `retry_after`. |
| DW-08 | med | PARTIAL | A 5-minute sweeper runs, and refresh claims expire. Uncertain creations are marked failed instead of being resolved by asking Canva. |
| DW-09 | med | FIXED | Retry policies are explicit, and the chaos suite runs on real Restate 1.7.10. TaskWorkflow and DesignRun still use server defaults. |
| DW-10 | med | PARTIAL | A studio re-drive goes through the outbox. The planner re-drive still runs inline under `Date.now()` keys. |
| DW-11 | med | OPEN | Ingress dedupe rows are written in separate transactions. A duplicate with no task is acknowledged. |
| DW-12 | med | OPEN | Simulators are still exported and used by live routes. |
| DW-13 | low | FIXED | Replaying an uncertain send needs confirmation, and poll-now is admin-only. |
| V-1 inbound drop | high | FIXED | 5 attempts counted in Postgres, then the update is parked with an office alert and the sender told. |
| V-2 Canva breaker | med | OPEN (mitigated) | Still fed only by fault injection. Health now also reads the connection row. |
| V-3 one-shot workflow key | med | PARTIAL | A re-drive gets its own key. A 409 still gets an invented `inv_conflict_reconciled_*` receipt, and the per-process receipt cache is never cleared. |
| V-4 publisher validation | low | PARTIAL | Validation is still a list of test substrings. Token failure is now reported correctly. |

**End-to-end trace (production path):**

- **Poll:** durable and idempotent.
- **Classify:** a paid call re-runs if the crash comes before the commit.
- **Intake commit:** one transaction.
- **"Request saved" ack:** not durable (N-WF-2).
- **Dispatch:** durable.
- **Design run:** journalled.
- **Outcome to Core:** durable. The preview photo is fire-and-forget (N-WF-3).
- **Revision and QC:** one transaction, so the approval gate is now reachable.
- **Approval:** human step.
- **Delivery:** runs inside an HTTP request across 4 transactions. A crash leaves the task `publishing` until someone presses Deliver again. There is no reconciler.
- **Requester notice:** durable.
- **COMPLETE and ledger:** separate transactions (N-WF-1).

**Verdict:** the chain can complete in code, and the chaos stack exercises it. There is no evidence it has completed in production: the latest restored dump holds 0 tasks after release A.

| New | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| N-WF-1 | med | Delivery notice can be lost while the task completes. *(checked)* | `omnichannel-delivery.ts:811-845,880` | Write the outbox row, COMPLETE, `drive_refs` and `markComplete` in one transaction. |
| N-WF-2 | med | The intake ack is inline. If it is lost, the worker also suppresses its own message, so the requester may never be told. | `chat-campaign-intake.ts:533-535,586-597`; `canva-draft-workflow.ts:400` | Queue the ack in the intake transaction. |
| N-WF-3 | med | The draft preview photo (which carries the Task ID replies are routed by) is fire-and-forget. | `canva-outcome.routes.ts:271-285,374-413` | Queue it as an outbox command. |
| N-WF-4 | med | Flagged-chat requests can get stuck in `designing`, with no watchdog. | `design-run.ts:94,160-170`; `request-lifecycle.ts:559-563` | Schedule a delayed `designTimeout` self-send. |
| N-WF-5 | low | The inline status send is not fenced against its outbox copy, so "draft ready" can be sent twice. | `canva-outcome.routes.ts:289-334` | Write a send mark before sending. |
| N-WF-6 | low | Clarification context lives in Core memory. A deploy can turn an answer into a new paid brief. | `telegram-webhook.routes.ts:36-39`; `replies.ts:370-435` | Persist it. |
| N-WF-7 | low | The instruction-only notice is sent before the commit, and again on every retry. | `telegram-webhook.routes.ts:219-238` | Send after the commit. |
| N-WF-8 | low | A missing `HAWA_BEARER_TOKEN` throws outside any step. DesignRun uses the operator bearer. | `canva-draft-workflow.ts:121,295` | Check it at startup; use `HAWA_WORKER_TOKEN`. |

## D. Creative engine and design output (5.3/10)

| ID | Sev | Status | Evidence |
|---|---|---|---|
| CRE-02 | high | OPEN | 7+ font lists disagree: `render-layout-v2.ts:96,242`, `design-metrics.ts:42`, `transfer-v2.ts:~290`, `qa/canva-pptx-check.ts:4`, `font-policy.ts:57`, `canva-design-planner.ts:170`. |
| CRE-03 | high | PARTIAL | A width COPY_OVERFLOW check exists. Wrapping is greedy and `\s+`-only; long tokens are never broken. |
| CRE-08 | high | PARTIAL | The declared-colour gate is wired. `qa/contrast.ts:171` and `vision-rubric.ts:182` use other thresholds. Opacity, art and photos are ignored. A bad colour parses as black. |
| CRE-01 | med | OPEN | KAAE is hard-wired into the persona, logo and palette. |
| CRE-04 | med | OPEN | No script itemisation. Noto Sans Arabic returns 10 .notdef glyphs for "kaae.gov.krd 2026". |
| CRE-05 | med | OPEN | The engine checks are string stubs, and `validatePackage` always passes. `rtl-validator.ts:288-320` never pushes an error. |
| CRE-06 | med | OPEN | The orthography modules have no callers. Intake maps only yeh and kaf. |
| CRE-07 | med | OPEN | Comparison tooling exists, but there are no results. |
| CRE-09 | med | PARTIAL | See P1. |
| CRE-10 | med | OPEN | 4,212 lines of v1 templates are still exported. |
| CRE-11 | med | OPEN | Repair output is not schema-validated. Colours are interpolated unescaped into SVG. |
| CRE-12 | med | PARTIAL | Verdana is handled. OFL texts are missing, `/Users` paths remain, and `render-fonts.json` is not in `dist`. |
| V-sanitizer | med | OPEN | See N-SEC-10. *(reproduced)* |
| V-layout-tests | med | OPEN | No tests for `wrapTextWithFontkit`, `measureMaxLineWidths` or `fitText`. |
| V-legacy-QA | high | FIXED | The 9-step generator is deleted. |
| V-font-fidelity | med | PARTIAL | 'unmeasured' counts as 'exact' (`render-layout-v2.ts:592`). There is no FONT_SUBSTITUTED check. |
| D1 line rules | high | FIXED | `line-geometry.ts`, with a passing test. |
| D2 widows | med | PARTIAL | Balanced widths, except for multi-paragraph copy. |
| D3 panels / regularity | med | OPEN | `computeRegularity` still rewards equal gaps. |
| D4 type scale | med | PARTIAL | A story safe zone was added. Eyebrows can drop to 10 px (N-CRE-2). |
| D5 Sorani bold | med | FIXED (code) | Real bold files are committed. No run proves it. |
| D6 template sameness | med | N/D | No proof run since 09-18. |
| D7 ragged right | low | FIXED | |
| D8 visual QA ≠ shipped design | high | OPEN | `qa.stage.ts:11` checks geometry only. The canary renders without the logo and photos. |
| D9 art dimmed | low | PARTIAL | Art is drawn at opacity 1. No new composites to judge. |

**Arabic/Sorani coverage:** still zero Arabic designs. No proof folder is newer than 09-18. Stored briefs by language: 19 en and 19 ckb `brief.json` files, plus 240 run brief IDs (120 en, 120 ckb).

| New | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| N-CRE-1 | med | The KAAE logo is the default in other clients' renders. The judge-canary renders never include photos or the real logo. | `render-layout-v2.ts:1538-1545`; `pipeline-v3.ts:1444,1450` | Make the logo explicit, and pass the logo and photos to the canary. |
| N-CRE-2 | med | Eyebrow shrink-to-fit goes to 10 px, below the 12 px floor. QA checks the layout size, not the drawn size. | `render-layout-v2.ts:1364`; `house-rules.ts:20` | Stop at the floor, raise COPY_OVERFLOW, and check the fitted size. |
| N-CRE-3 | med | NBSP is treated as a line break and rewritten to a space. *(reported reproduced by the reviewer)* | `render-layout-v2.ts:1272-1279` | Split on `[ \t]+` or UAX #14, and keep the original separators. |
| N-CRE-4 | med | `spawnSync` still runs on Core's live judge, motif and font-probe paths. | `pipeline-v3.ts:1444,1450`; `motifs.ts:310`; `render-layout-v2.ts:268`; `color-science.ts:193` | Use async `execFile`, and lint-ban `spawnSync`. |
| N-CRE-5 | med | The KAAE DNA file is not copied into the image, and the loaders silently do nothing. The `/Users` paths only work on the owner's Mac. | `feedback-miner.ts:446-455`; `client-learning.routes.ts:208-226`; `Dockerfile.core` | Use one env-rooted config dir, COPY it, throw when it is missing. |
| N-CRE-6 | med | The font-policy "single source" admits fonts the registry refuses or has no files for. | `font-policy.ts:17-85`; `editable-transfer.ts:53` | Filter to fonts that are admitted and have files. |
| N-CRE-7 | low-med | The Canva-export RTL check fails open. | `canva-pptx-check.ts:299-301`; `core-helpers.ts:269` | Make it tri-state, and block auto-approve on `unverified`. |
| N-CRE-8 | low-med | The overflow gate fails open when text cannot be measured, and measures the requested face rather than the face drawn. | `render-layout-v2.ts:853-855,965-967,1483-1490`; `hard-qa.ts:182,190` | Emit an UNMEASURABLE_TEXT defect, and measure the drawn face. |
| N-CRE-9 | low | Arabic is typed as `ckb`. RTL headlines are cut at 65 chars. The deck tags Arabic `lang="ku"`. | `chat-campaign-intake.ts:277-278,312-314`; `transfer-v2.ts:579,615` | Detect ar vs ckb, and never truncate. |

## E. LLM, gateway and evals (4.5/10); performance and cost (5/10)

| ID | Sev | Status | Evidence |
|---|---|---|---|
| LLM-01 | high | OPEN | The evals cannot fail (`runner.ts:193-203,338-505`; `redteam-runner.ts:66-80`), and the runner defaults to `FakeModelGateway`. |
| LLM-02 | med | OPEN | The fake gateway replays expected answers. "Blind holdout" is still the label. The same data is now in the production gateway (N-LLM-1). |
| LLM-03 | med | FIXED | `--live` exits 1. Dead code remains. |
| LLM-04 | med | OPEN | The exemplar query reads fields `Scope` does not have, so it always queries `''` (`design-studio-service.ts:1056-1062`). The tokenizer is ASCII-only. |
| LLM-05 | med | OPEN | Retrieval scores are invented, results are sliced without sorting, and ingest uses a placeholder document (`retrieval-service.ts:220-340`). Nothing calls it. |
| LLM-06 | med | PARTIAL | Count caps on auto-drafts and a $6 per-run budget exist. There is no dollar cap per day or per month. |
| LLM-07 | med | OPEN | 14 direct provider call sites. The egress lint allowlists all 10 of their files. |
| LLM-08 | high | PARTIAL | Truncation, refusal and parse errors are typed and billed. `strict:false`, no schema, and a 200 with no choices becomes `'{}'` counted as success. |
| LLM-09 | med | OPEN | The judge is told the metrics are "GROUND TRUTH", and "ties are not permitted". |
| LLM-10 | med | OPEN | No prompt hashes. The release manifest's model pins do not match the code. |
| LLM-11 | med | OPEN | The held-out briefs are inline in the script being tuned. |
| LLM-12 | low | OPEN | `.replace` with untrusted strings expands `$&` and `$'` and allows token capture. |
| V: unparseable 200 retried at $0 | high | FIXED | |
| V: art vision check fails open | med | OPEN | `gemini-image-provider.ts:186,199-204,290-299`. |
| V: `/evaluations/runs` sync in prod | med | OPEN | Any role can call it, and results go into an unbounded Map. |
| V: judge defers to composite | med | OPEN | |
| P1 spawnSync | high | PARTIAL | See N-CRE-4. |
| P2 admission cap | high | PARTIAL | The worker waits durably for up to 15 min. The cap of 2 is hard-coded, with no queue. |
| P3 simulated SLO evidence | high | PARTIAL | A real load test exists, but traceability still cites the simulated loop for FR-062. |
| P4 Telegram serial intake | med | PARTIAL | Download has a deadline but no byte cap. The worker poller is off by default. |
| P5 bytea in status route | med | PARTIAL | `getCandidatesForRun` still uses `selectAll`. |
| P6 Core singleton maps | med | PARTIAL | `evalRuns` is unbounded. SSE and clarifications are in-process, so Core cannot run as more than one instance. |
| P7 slow call / $0 retries | med | PARTIAL | Timeouts are recorded at $0. |
| P8 sequential judge calls | low | OPEN | |
| P9 set_config round trips | low | PARTIAL | |
| P10 container limits | low | PARTIAL | Only cutout and vector have limits. |

| New | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| N-LLM-1 | high | The production gateway embeds the eval answer key. When no live output is available, the fallback is labelled with the real provider and model and invented tokens and cost. The visual judge always approves. *(checked; reviewer reproduced with no keys)* | `model-gateway.ts:144-173,519-520,719-775,839-846` | Delete the answer-key path. Return an error when there is no output, and report provider `local` when the call did not succeed. |
| N-LLM-2 | med | Rules from a chat or PDF become "authoritative" system-prompt text with no review. | `telegram-rules-intake.ts:275-289`; `client-rules.repository.ts:147`; `design-studio-service.ts:799-808` | Store them as `pending` until approved, and wrap them as untrusted data. |
| N-LLM-3 | med | Client scope is not frozen once a run starts. | `design-studio-service.ts:1029,1198` | Snapshot rule IDs and hashes at claim time, and fail on drift. |
| N-LLM-4 | med | Intake-side model calls are unledgered and uncapped. | `telegram-classifier.ts:451-583`; `telegram-intake/media.ts:172`; `canva-design-planner.ts:476`; `voice-transcriber.ts:96` | Send them through one metered client with a daily dollar cap per tenant. |
| N-LLM-5 | med | `completeJson` never enforces its schema. Stages use `response.data` without checking it. | `openai-studio-client.ts:633`; `critique.stage.ts:126-129`; `concepts.stage.ts:156-186`; `brief.stage.ts:170-178`; `parity.stage.ts:97` | Set `strict:true`, validate with zod, and return a typed error. |
| N-LLM-6 | med | Every stage advance reads each candidate's PNGs twice (bytea plus the file store). | `design-studio.repository.ts:161-195,338-356` | Drop bytea from the select, and load images lazily. |
| N-LLM-7 | low | The egress lint cannot fail for the files that matter. | `scripts/lint_provider_egress.ts:21-32,47` | Allow one gateway module, and enforce with an AST rule. |
| N-LLM-8 | low | Assets are read synchronously on every stage advance. | `design-studio-service.ts:1056-1098`; `exemplar-retrieval.ts:102-190` | Load them once at startup. |

## F. Desk (5/10) and maintainability (4.5/10)

| ID | Sev | Status | Evidence |
|---|---|---|---|
| DESK-01 | crit | FIXED | Health comes from real integrations. Re-Queue is wired to the API. |
| DESK-02 | high | PARTIAL | A cache miss answers 503. A cache hit offline still serves a stale 200. |
| DESK-03 | high | PARTIAL | sessionStorage, SSE tickets, server logout and a meta CSP. `__HAWA_CONFIG__.apiToken` wins and cannot be cleared. The CSP allows `http: https:`. |
| DESK-04 | high | FIXED | |
| DESK-05 | high | OPEN | Studio runs are orphaned on reload. The selection snaps back (stale closure, `StudioPanel.tsx:147-185`). |
| DESK-06 | med | OPEN | No `expectedVersion` on DNA save. No task version or hashes on approve. |
| DESK-07 | high | PARTIAL | 2 jsdom test files exist. Playwright is not a dependency. |
| DESK-08 | med | OPEN | The Canva editor link is dead. 6 of 6 palette actions do nothing. Palette search sends no auth header. |
| DESK-09 | med | PARTIAL | TanStack Query on the Work screen. Other screens fetch in effects. Manual intake wedges on a 4xx. |
| DESK-10 | med | OPEN | `DnaScreen` is 1,827 lines. 891 inline styles. |
| DESK-11 | med | OPEN | 43 `request<any>` calls. No ErrorBoundary. |
| DESK-12 | med | OPEN | `dir`/`lang` are not applied at startup. |
| V: shortcuts | high | OPEN | `j`/`k` retarget the selected task while a modal is open (`WorkScreen.tsx:307-373`). |
| V: always-green | med | OPEN | Hard-coded "6/6 Invariants", "verified active" and "Scope … locked". |
| V: i18n / dead queue / untyped tests | low | OPEN | |
| TS-01 | high | PARTIAL | Hydration is fixed. `Map<string, any>`. No Task type. |
| TS-02 | high | PARTIAL | `app.ts` is split. `handler: any`. 91 `async (c: any)`. |
| TS-04 | med | OPEN | `(auth as any).clientId` can never fire (`decisions.routes.ts:152`). |
| TS-05 | high | OPEN (worse) | 184 test files / 27.5k lines of 79.4k are type-checked, with `strict:false`. |
| TS-06 | high | PARTIAL | CI exists but has never run. No eslint. `pnpm lint` checks 0 files. |
| TS-07 | med | OPEN | Core ships `@hawa/testkit` (`app.ts:55,212`), and there is a core↔testkit cycle. |
| TS-08 | med | OPEN | The README still describes HyCanvas, ComfyUI and Phoenix, with no commands. |
| TS-09 | low | OPEN | No ADR index. |
| TS-10 | med | PARTIAL | 146 MB tracked (was 371). `output/` is 112.8 MB. No LFS. |
| TS-11 | med | OPEN | 15 excluded non-compiling scripts (7,313 lines). |
| TS-12 | med | OPEN (worse) | `sql<any>` is 75. |
| V: deploy dirty stamp | high | PARTIAL | A dirty tree is refused, but `ALLOW_DIRTY_DEPLOY=1` stamps a bare HEAD. |
| V: DB error logged, success returned | med | OPEN | `decisions.routes.ts:409-411`. |
| V: Desk monolith screens | med | OPEN | |

| New | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| N-DESK-1 | med | The new-request client list is hard-coded and includes the demo clients Drustee and FastPay. | `App.tsx:137-144,490` | Load the list from the API. |
| N-DESK-2 | med | The any-ratchet skips `.tsx` and `Map`/`Record` generics, and has 77 of headroom. | `scripts/ratchet_any.ts:16,29,52` | Widen what it counts, and set the ceiling to the current count. |
| N-DESK-3 | med | `pnpm lint`'s `tsc --noEmit` checks 0 files. *(checked)* | `package.json:11`; `tsconfig.json` has `files: []` | Use `tsc -b --noEmit`. |
| N-DESK-4 | low | The Playwright e2e suite cannot run. | `apps/desk/package.json:10` | Add the dependency and a real flow, or delete it. |

## G. Tests (5.5/10) and build/CI/ops (4/10)

| ID | Sev | Status | Evidence |
|---|---|---|---|
| T02 | high | PARTIAL | The default bypass is gone. `x-user-role`, `testAuth` and `x-enforce-auth` remain in production auth code. |
| T03 | high | PARTIAL | 82 of 270 `createApp` calls in core tests pass no DB. |
| T05 | high | OPEN | The R14 counters are never incremented. The DR test greps script text. |
| T08 | high | PARTIAL | A chaos suite exists but is gated on `HAWA_CHAOS=1` and not in CI. `setCrashAfter` has no caller. |
| T01 | med | OPEN | `@hawa/*` resolves to `dist/`, and `pnpm test` never builds. |
| T04 | med | OPEN | 66 `describe.skipIf(!url)` files. The config comment claims the DB suites "fail loudly". |
| T06 | med | OPEN | 23 tests only re-read committed JSON. Desk tests `readFileSync` source. |
| T07 | med | FIXED | |
| T09 | med | OPEN | A hand-rolled Kysely fake. The e2e test runs on an in-memory DB. |
| T10 | med | OPEN | No property tests. The fuzz test accepts 201 for malformed JSON. |
| T11 | med | PARTIAL | Per-file DB clones. Wall-clock asserts remain. |
| T12 | med | PARTIAL | WorkScreen is parsed, never rendered. |
| V: kill-switch (WAHA) | high | FIXED | |
| V: core-table RLS test | med | PARTIAL | Covers tasks only. |
| V: GooglePublisher emulator | high | FIXED | |
| V: non-hermetic DB tests | med | FIXED | |
| OPS-01 | high | PARTIAL | `ci.yml` exists but has never run. There is no linter beyond tsc, and coverage is never run. |
| OPS-02 | high | PARTIAL | `ALLOW_DIRTY_DEPLOY` and `HAWA_BUILD_COMMIT` override the stamp. Images are `:latest`. |
| OPS-03 | high | FIXED | `probeDatabase` fails closed. |
| OPS-06 | high | OPEN | Production runs from per-user launchd agents on a Mac. No external heartbeat. |
| OPS-07 | high | PARTIAL | The default archive is on the same host. A gsutil failure only warns. Backups are nightly (24 h RPO). |
| OPS-08 | high | PARTIAL | A JSON logger and Vector exist. The Phoenix exporter is a no-op that reports success. No metrics. |
| OPS-04 | med | PARTIAL | Migrations run before the image build. No rollback. The health check does not read `status`. |
| OPS-05 | med | PARTIAL | The worker does not drain in-flight work or close its pool. |
| OPS-09 | med | PARTIAL | The manifests cover 0 runtime files. Nothing is signed. |
| OPS-10 | med | OPEN (worse) | 114 distinct `process.env` keys across 65 files. |
| OPS-11 | med | OPEN | Floating base images. Dev `node_modules` and tests are shipped in the image. No `packageManager` pin. |
| OPS-12 | low | OPEN | `deployment/` is still wired into `package.json`. |
| V: predeploy dumps | high | FIXED | |
| V: unwindowed alerts | med | OPEN | |
| V: Dockerfile hardening | med | OPEN | |
| V: restore runbook | med | PARTIAL | The pgBackRest and restic fiction still opens the runbook. |

| New | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| N-OPS-1 | critical | CI has never executed a step (60/60 runs, `runner_id: 0`). *(checked via the Actions API)* | `.github/workflows/ci.yml` | Fix the account, billing or runner issue. Make the check required. |
| N-OPS-2 | high | Once CI runs, it would skip every DB suite and fail on missing fonts and rsvg. | `ci.yml:40-78` | Add a pg17 service, `test:db`, a font and rsvg setup script, and a skip budget. |
| N-OPS-3 | high | The test type-check excludes all core and worker tests. | `tsconfig.test.json:6,46-48`; `scripts/typecheck_tests.ts:25` | Remove the excludes and turn on `strict`. |
| N-OPS-4 | high | The release gate's verdict ignores its gates and invents numbers. *(checked)* | `enforce_release_gate.sh:225-226,239,285,321` | Derive the verdict from each gate result. |
| N-OPS-5 | high | The DR drill's RLS check can never fail. *(checked)* | `disaster_recovery_drill.sh:323` vs `db/rls.sql:12` | Use `app.tenant_id`, and add a positive control. |
| N-OPS-6 | high | The "chain closed" e2e test replaces the production handler. | `e2e-canva-to-delivery-chain.test.ts:261` | Use the production consumer with a fake transport. |
| N-OPS-7 | medium | Gate W's restore test concatenates strings. | `packages/db/test/backup-restore.test.ts:11-48` | Do a real `pg_dump`/`pg_restore` and compare. |
| N-OPS-8 | medium | The release gate dirties the tree it certifies. Its refusal drill is macOS-only (T-1). *(reproduced)* | `enforce_release_gate.sh:46,262+`; `deploy.sh:90` | Use `mktemp`, portable sed and an untracked evidence path. Remove the bypass. |
| N-OPS-9 | medium | The SBOM step is broken on pnpm 10. `sbom.json` dates from 09-04. | `package.json` `sbom`; `ci.yml:117,128` | Use `cdxgen` or pin pnpm ≥ 11. |
| T-2 | medium | `draft-reminders` test is a time bomb. *(reproduced)* | `apps/core/test/draft-reminders.test.ts:125` | Inject a fixed `now`, and create the draft relative to `REMINDERS_FROM`. |
| T-3 | low | The `cv17` bundle-size test needs a separate Desk build. | `apps/core/test/hawa-work-desk-cv17.test.ts:125` | Build in `globalSetup`, or move it to the Desk build job. |
| T-4 | low | A test writes `temp_art_*.png` into a tracked proof folder. *(observed)* | `output/proofs/2026-09-17-research-grade-pipeline/P04_ART/` | Write to `tmpdir`. |
