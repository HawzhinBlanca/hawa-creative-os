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

## Consequences and limits

- Verified with a real SIGKILL of a child process in the middle of the archive
  step against a file-backed fake engine, and with the watchdog run against stubbed
  Docker, curl and sleep. No production Docker engine, Core, PostgreSQL or Restate
  was contacted. The production backup schedule remains off (ADR-053).
- A kill between Core's pause answer and the record write leaves an unreleased
  pause the office must release; this is deliberate refusal rather than a guess.
- The watchdog's `notify` no longer ends the pass with exit 2 when the production
  environment file is absent (the guard `nightly_backup.sh` already had).
