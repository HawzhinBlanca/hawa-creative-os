# ADR-127 — Integrating studio-v2's remaining work into the mainline

Date: 2026-09-28. Status: implementation; items needing the owner are listed below.
Requirements: FR-007, FR-011, FR-017, FR-070, NFR-003, NFR-013. Normative sources:
MASTER_SPEC.md, docs/08_MEMORY_RAG_CLIENT_DNA.md, docs/09_MESSAGING_AND_OFFICE_INBOX.md,
docs/10_WORKFLOW_RELIABILITY.md, runbooks/10_backup_restore.md,
adrs/053_guarded_single_node_restate_backup.md, adrs/054_fenced_intake_switch_release.md.

## Context

On 2026-09-28 the owner made `codex/research-grade-design-system` the mainline. Work
committed to `studio-v2` after the two branches parted (`1c1316d`) exists only there.
This ADR records how each part is carried over. Where the branches solve the same
problem differently, this branch's stricter guarantee is kept and studio-v2's intent
is fitted to it. studio-v2's RequestLifecycle (its waves 7 and 8, migration 023) is
superseded by this branch's own implementation (ADR-034, ADR-052, ADR-059 onward) and
is not ported.

## Decision: studio-v2's ADR-038 becomes this ADR

studio-v2 numbered its client-pack decision ADR-038. On this branch ADR-038 is
"release identity is two-phase". The client-pack decision is carried here, and
every reference in ported code, tests and documents names ADR-127.

## Decision: client packs route and scope; Client DNA stays the brand authority

Each client is a validated pack in `packages/creative/assets/clients/<code>.json`:
identity, the Telegram chats and words that name it, the formats it orders and
its default canvas, its playbook, and whether it is `live` or `onboarding` with
what it still lacks. KAAE is live; ZAR Podcast, Halwest News, Kawa ba Hawlery and
Erbil Edition are onboarding, with YouTube 1280×720 and 9:16 reels, and no
Kurdish alias or chat guessed.

- Intake routes a bound chat first, then the one client a message names; a
  message naming two pack clients is left for the office. The legacy demo-client
  detection runs only when no pack matched and the message was not ambiguous.
- An onboarding client is saved on its own canvas with no automatic draft, and
  the requester is told why. The lifecycle new-brief draft (ADR-059) is built by
  the same function and carries the same `autoGenerate`.
- Core inserts missing `hawa.clients` rows for every pack at start-up and never
  changes an existing row; the seed carries the four new rows.

Conflict with this branch, and the stricter guarantee kept: studio-v2's pack also
named a reference pack and logo file the studio and planner read for the client.
Here the design reference is the client's active, versioned Client DNA with a
hashed logo in the blob store (`client-design-reference.ts`), refused when absent,
and KAAE's packaged reference is a transitional input that never serves another
client. A pack therefore carries no reference, palette or logo (the schema
refuses such keys). A client without active DNA is refused as before; the
refusal now also names what an onboarding pack lists as missing. A pack's
`live` status does not admit a design: Client DNA does.

## Decision: the video-thumbnail playbook; the logo half is already stricter here

studio-v2's 1d07664b removed the renderer's KAAE logo default (it drew a grey
placeholder instead) and passed the client's logo and photos into the v3 judge,
canary and critique renders. This branch's ADR-047 already refuses a
logo-bearing render without an explicit client logo, and ADR-109 hands the
candidate's real logo, art, photos and cutouts to refinement, fallback comparison
and both sides of the canary. Both are stricter than a placeholder, so that half
and d66804ce (golden KAAE tests handing in KAAE's logo) are superseded.

The playbook is ported. A pack whose playbook is `video-thumbnail` has the
thumbnail rules appended to the rules every stage reads (listing size 168 px for
16:9 and 180 px for 9:16, the person as focal point, the hook as the largest
text, copy never cut, a small top-corner logo), and hard QA adds
`THUMBNAIL_COVERED_ZONE` and `THUMBNAIL_HOOK_TOO_SMALL`. Copy length stays
guidance: the copy is exact. An announcement client's rules, and therefore its
pinned visual policy (ADR-112), are unchanged. studio-v2's "no brand ornament for a
thumbnail" is already true here: only KAAE's packaged reference gets an ornament.

## Decision: KAAE's persona and palette leave shared design code

Ported from 27e9e4f1 and f6d6ed1b. The v3 layout system prompt no longer names
KAAE; the client comes in the request (`CLIENT:` from the pack's `profile`), and
the pairwise judge scores brand fit against that profile instead of
"institutional prestige, elegance, academic gravitas". The critique prompt is
neutral. The layout normaliser repairs contrast from the client's palette;
style and ornament fallbacks are neutral greys; a reference without a palette is
refused rather than filled with KAAE's. KAAE hex values remain only as points in
colour space for finding the nearest colour of a client's own palette. A guard
test fails if KAAE's identity or colours return to the judge, critique, layout,
art or QA code.

Kept from this branch where it was already stricter: the art prompt and the
degraded motif already use the layout's own colours, and `composeArtPrompt` and
the motifs refuse art without a client palette (studio-v2 fell back to neutral
tones); the Canva planner already states and corrects to the client's palette
(`buildPlannerSystemPrompt`, `correctPlannerPalette`).

The profile reaches the v3 layout generator and the judge through the stage
context; it is not appended to the rules every stage reads (studio-v2 did), so a
client's pinned visual policy hash (ADR-112) does not change. The v3 layout and
judge prompts do change for KAAE: a KAAE v3 run resumed across this change finds
its retained layout or judge call input changed and holds (ADR-111), which is the
intended safe outcome, not a replay.

## Decision: a client's exemplars are named by its pack

Ported from 24a787cd, narrowed. A pack names its own confirmed exemplar manifest
(`exemplars`) or null; only a live pack may, and no two packs may name one file.
KAAE's pack names `kaae-exemplars.json`, the same file, so its exemplar policy
hash is unchanged. The studio and the Canva planner read the manifest through the
pack instead of a hard-coded KAAE path, and still only where ADR-115 admits
exemplar conditioning (KAAE's packaged reference). studio-v2's per-client
libraries (`add_exemplar.ts --client`, `exemplars/<code>/`, manifest vocabulary
and retrieval hints) are not ported: ADR-115 replaced that retrieval with Unicode
lexical ranking over a hash-verified, KAAE-only collection, and another client's
library needs its own admission design (approval, hashes, pinning) before any
client other than KAAE is conditioned on exemplars.

## Decision: the v1 KAAE templates are retired

Ported from 4d3f393d unchanged in substance. The four v1 KAAE template files and
`CreativeDirectorRunner.generateKaaeOperations` are deleted. They served only the
chat-intake inline preview (off in production) and `POST /tasks/:id/generate`,
which now refuses KAAE with 410 `LEGACY_TEMPLATES_RETIRED`: its generic draft could
pass QA and reach review as a KAAE design nobody designed. A KAAE request without
copy is still refused `COPY_REQUIRED`. The generic generator loses its KAAE
styling, `generateCommercialBrandOperations` no longer falls back to KAAE's
templates for an unknown brand, and seven proof scripts bound to the templates
are deleted (none ran in CI). KAAE is designed only in the studio.

## Decision: the 2026-09-27 audit fixes on KAAE's live chain

Ported from 66e483e8, each against this branch's code. Ported: a stored approval a
later edit invalidated is delivered only by an administrator with a reason and
still needs its QC evidence (#2); a pending client change blocks Core delivery
on every path (#3); an approval whose QA run cannot be read is refused 503 instead
of reaching the generic 412 (#14; this branch already required a passing run
everywhere, stricter than studio-v2's production-only rule); standing client
rules reach the models quoted, as data (#15), and a run reads the rules in force
when it started (#16); `POST /operations/kill-switch` is an administrator's and
answers after the revisioned save of ADR-054, returning its `changeTag` (#17); the
SVG sanitizer strips to a fixed point (#11); the Desk clears its offline copies at
sign-out (#21); no shipped source names a path on the owner's Mac, and the unused
named people leave `config/clients/kaae.dna.json` (#22).

Superseded here: #12 (studio-v2 left the task in PUBLISH_RECONCILIATION when the
requester's notice could not be queued; this branch enqueues the notice in the same
transaction as the Drive and Sheets receipts, so the whole delivery is held with
503 `RECEIPTS_NOT_RECORDED`) and #16's reference drift check (studio-v2's
`CLIENT_SCOPE_CHANGED`; this branch refuses with `CLIENT_REFERENCE_CHANGED` when
the run's recorded reference or logo hash no longer matches).

## Decision: a Restate backup killed outright is put back by the watchdog

studio-v2's Restate backup was a shell script; its watchdog skipped a pass while a
backup ran and ran `restate-nightly.sh --recover` once a killed run's PID was gone
(088ce5e6, 4eb16341). This branch has its own backup (ADR-053 to ADR-057) and keeps
it. It restored Restate and the intake switch only in a `finally` block, which a
SIGKILL or a reboot never runs: Restate stayed stopped until the watchdog's generic
restart (which could also start Restate under a live cold copy), and intake stayed
paused with the pause revision lost, so nothing could release it safely.

Only the missing capability is ported, in this branch's structures:

- `--apply` writes an owner-only run record before each change: `switch`
  (`none`, `pausing`, `paused` with the returned `changeTag`) and `restate`
  (`running`, `stopping`). A cleanly finished or cleanly failed run removes it.
- Liveness is the archive lock (ADR-053; held for the whole night since ADR-081),
  not a PID: a process's `flock` ends with the process, however it ends, and a PID
  can be reused. Without a record, `--recover` returns before touching the lock.
- `--recover` does nothing while any backup holds the lock. Otherwise it starts
  Restate and waits for health if the record says it was stopped, then releases the
  intake pause only through ADR-054's conditional release with the recorded
  revision. A conflict means an operator decided later; the switch stays theirs.
  A `pausing` record (killed between Core's answer and the write) is never a
  release: it is reported until the office releases intake itself. Any failure
  keeps the record for the next pass.
- The watchdog runs `--recover` first on every pass and skips the pass while a
  backup is alive; `--status` uses the read-only `--recovery-status`. The next
  `--apply` performs the same recovery before it records anything of its own.
- A record held under a live lock for over two hours is reported as a stuck
  backup; that pass then continues as before (it may start Restate).

Limits: verified with a real SIGKILL of a child process in the middle of the
archive step against a file-backed fake engine, and with the watchdog run against
stubbed Docker, curl and sleep; no production Docker engine, Core, PostgreSQL or
Restate was contacted, and the production backup schedule remains off (ADR-053).
A kill between Core's pause answer and the record write leaves an unreleased pause
the office must release: deliberate refusal rather than a guess. The watchdog's
`notify` no longer ends the pass with exit 2 when the production environment file
is absent (the guard `nightly_backup.sh` already had). studio-v2's backup script,
restore script and chaos restore drill (088ce5e6) are not ported: ADR-053 to
ADR-057 and ADR-081 already cover guarded capture, fenced release, the paired
nightly archive, retention and an isolated boot rehearsal.

## Decision: operations work is ported, adapted to this branch's structures

- CI (1a160953, 9cd4afeb, c2bf4943): the workflow runs on a clean Ubuntu runner
  with its own PostgreSQL service, render dependencies, lint, live schema parity,
  the Desk build and a clean-tree check, and runs for this branch. This branch's
  native text-measurement helper (ADR-118) needs Pango headers, so the render
  dependency script installs them and the eval job installs them before `pnpm
  build`. The release-manifest check accepts a build commit that is an ancestor of
  HEAD with only manifest files changed since, and refuses real drift. This does
  not change ADR-038's two-phase release identity.
- Deploy (644fd8dd): Core's health is asked for up to a minute after the switch;
  when only internet dependencies are unreachable the deploy ends with a warning.
  The OpenAPI fix is adapted: this branch already documented pause, resume and
  cancel with the body its routes read; the stale `{control}` catch-all is removed
  and `retry` is documented as the 409 refusal Core returns.
- Canva panel poll (ecc9af71): 5 s only while Canva or the planner is working,
  otherwise 60 s, and a refresh on the task's live event. The amendment
  observation stays an explicit action (ADR-119).
- Load test and runbook (5e64ae31): ported; the runbook's Phase 2 flag sections
  describe this branch's lifecycle (ADR-052, ADR-059), every command block says
  whether it was run again on this branch, and studio-v2's Deliver-time enrolment
  drill and its helper are not ported. The chaos compose duplicate-key fix
  (e8169f44) is not needed: a duplicate-key YAML load finds none here.
- File store (4e2e6e58, 75153027): the backfill fixes and the staged release B
  keys are ported; the staged keys remain outside the migrations directory and
  were checked against migrations 023-064. No migration is added (number 070 is
  unused by this package).
- Documents (1869518d, 9a4a38b3, 82240d9e and the evidence of 4eb16341) are kept
  as history, each with a note that studio-v2's RequestLifecycle was superseded.

## Not ported

studio-v2's RequestLifecycle (8b0d140b, d5a884cf, 5fb37d29, 736b0e9b, 3904fe07,
6269ef4e) and its migration 023 are superseded by this branch's own lifecycle
(ADR-034, ADR-052, ADR-059 onward). The "chore(release): record manifest"
commits are not ported; MANIFEST.json and SHA256SUMS.txt are refreshed here, and
RELEASE_MANIFEST.json is left for the lead to regenerate.

## Consequences and limits

- Nothing here was deployed, and no production SQL, Canva, Telegram or paid model
  call was made. Chaos-stack drills and the load test were not re-run on this
  branch.
- The four onboarding clients cannot be designed automatically until the office
  supplies their Client DNA (logo, palette, fonts), Kurdish aliases, chats and a
  proof set.
- Changing the KAAE v3 layout and judge prompts makes a KAAE v3 run resumed across
  this change hold on its changed retained call input (ADR-111).
- Five test expectations that lagged behind this branch's own migrations 063-064
  and the ADR-111/113/114/119 routes and blob columns were brought up to date in
  the same integration; the two `studio-ledger` resume cases already failed at the
  base commit (their stub has no `db.transaction`) and are left for their owner.

## Owner steps

- Supply each new client's Client DNA in the Desk, its Kurdish aliases and
  Telegram chats, and approve a proof set before setting its pack `live`.
- Decide whether to enable the unattended Restate backup schedule
  (`HAWA_RESTATE_BACKUP_ENABLED`) after a live rehearsal (ADR-053).
- Decide the production fixture row that blocks release B's staged keys
  (PHASE3_EVIDENCE.md), before those keys move into a migration.
