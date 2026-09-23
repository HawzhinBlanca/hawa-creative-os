# Designer-grade revisions: cut-outs, a request ledger, and a loop that stays until approval

**Date:** 2026-09-23 · **Decision record:** `adrs/032_photo_cutouts_and_request_ledger.md` (Proposed) · **Research:** `output/research/2026-09-23-cutouts-and-revision-loop/`

## Goal

A requester should get what they asked for, in as few rounds as a good office designer needs, and never be told something was done when it was not. The system should:

- do every change it has the means for, exactly as asked and nothing else;
- say plainly, before spending, what it cannot do, and hand that part to a designer;
- keep every earlier request in force through later rounds;
- stay with the requester until they press Approve.

"Better than the office's designer" is a measured claim, made only after the blinded comparison in Phase 5.

## Where we start (2026-09-23)

Done and deployed today: fixes 5, 6 and 7 from the incident.

| Fix | What changed | Proof |
|---|---|---|
| 5. Honest "can't do" | A reply is split into asks and each is marked possible or not, in the call the edit already made (no new cost). All impossible: the run stops before the paid edit, never designs afresh, and the requester gets "This change needs a designer" with the asks listed; the office is alerted. Part possible: only that part is made, and the edit is told not to stand in for the rest. A request to move text can no longer recolour it. | `apps/core/test/change-request-honesty.test.ts` (12 tests) |
| 6. Plain notes | The requester reads "✅ Done: …", "⚠️ Not done: …", "❌ Not possible automatically: … The office has been told", "Your 2 photos are on the design", and a warning when the reference has cut-outs the draft cannot make. Models, scores and coordinates go to the log and the notification record only. | same file, plus the existing note tests |
| 7. Photos kept | A change to a change finds its photos at the original request (the whole parent chain). An edit the design's photos did not reach is refused before any call (`PHOTOS_MISSING`) instead of removing them. | same file |

Cut-out trial on the real request's two photos: clean cut-outs from all three BiRefNet models (IoU 0.996+ between models). The edge halo is fixed by foreground estimation (0.08 s). 3–8 s per photo on CPU, about 8 GB peak memory (`CUTOUT_TRIAL_EVIDENCE.md`).

## Phase 1: Cut-outs end to end (first, because a real requester is waiting on one)

| # | Task | Done when (proof) |
|---|---|---|
| 1.1 | **Model bake-off** on 30–50 office portraits (phone photos, busy backgrounds, several people, hijab and hair, glasses): BiRefNet_lite-matting (our native-DeformConv ONNX export), BiRefNet-portrait, BEN2 base. | Per-photo mattes rated by the art director; gate pass rate; time and peak memory in the Docker VM; licence note per model. Winner and fallback recorded. |
| 1.2 | **Cut-out service** in the worker container (`onnxruntime-node`, one inference at a time, model pinned by sha256 on a mounted volume). Steps: face detection (YuNet, MIT), matting, foreground estimation, clamp, speck removal, per-person split by face boxes. | Unit tests on fixtures; a restart mid-cut-out resumes; the cut-out is cached by source hash, so the same photo is never cut twice. |
| 1.3 | **QA gates** (ADR-032 §2.1), calibrated in 1.1: face coverage, face count equals people, area 8–80%, component count, top edge not cut, haze band, model agreement, halo on black and white, and pixel-faithful (alpha ≥ 0.98 pixels identical to the source). A cut-out that fails uses the fallback model, then falls back to framed with an honest note. | A failing fixture for each gate. |
| 1.4 | **Layout `treatment: 'cutout'`**: renderer draws the RGBA with a contact shadow; hard QA uses the silhouette; people share a head height (face-box scale) and sit on the bottom edge or a band; faces never overlap. | Render tests; hard QA refuses text over a face. |
| 1.5 | **Canva transfer**: the person and the shadow as separate transparent PNGs in the PPTX. | A live round trip shows Canva kept the transparency and both layers are movable. Checked, not assumed: Canva does not document PPTX alpha. |
| 1.6 | **Brief and edit**: the brief sets cutout when the request or the reference calls for it (the brief already writes "cutout portraits"). The edit catalogue gains `photo.treatment`, so "make them cut-outs" is a possible ask. | Sewa's request replayed from its saved messages gives a draft matching her reference; 0 unrelated changes by structural diff. |
| 1.7 | **Owner:** Docker Desktop memory to 16 GB (Settings → Resources), and approve ADR-032. | `docker info` shows about 16 GB; ADR status Accepted. |

## Phase 2: The request ledger (ADR-032 §2.3)

| # | Task | Done when |
|---|---|---|
| 2.1 | `request_asks` table per design lineage: quote, ask, op, targets, params, status, reason, round, evidence. Replaces the free-form `stages.directed`. | Migration and repository tests; every revision's asks are queryable in Desk. |
| 2.2 | **Operation catalogue** v1, typed, with apply and verify for each op: text move/size/colour/weight/align/reflow; **copy edits** (`set_text`: today a wording change cannot be made at all); logo move/scale/variant; photo crop/replace/treatment/order; shapes; background colour and art; `clarify`; `unsupported`. The model returns ops, not a whole layout; code applies them. | Each op has a verify function; an unknown op is refused. |
| 2.3 | **Structural diff guard**: any change outside an op's declared fields is reverted and logged. | Property test: random unrelated edits are always reverted. |
| 2.4 | **Carry-forward**: every open or verified ask goes into the next edit's prompt, instead of chat history. | A three-round replay keeps round-1 asks intact. |
| 2.5 | **Semantic check** for asks that geometry cannot judge ("less empty space"): a yes/no VLM check on before/after, as advice beside the deterministic checks, never replacing them. | Agreement with the art director measured on 50 real asks before it is trusted. |

## Phase 3: Staying with the requester (ADR-032 §2.4)

- Telegram buttons on every draft: **Approve**, **More changes**, **Talk to a designer**. Only Approve closes the requester's side. A "thanks" is not an approval.
- Clarify rule: one question with options (two thumbnails, or buttons) when an ask maps to visibly different outcomes. Otherwise act and state the assumption.
- Escalation: an ask that is not possible, fails verification twice, or is open after three rounds. The designer gets the hand-off packet in Desk; the requester is told who has it and by when.
- Reminders at 24 hours and 5 days; then the thread is parked, never auto-approved.

## Phase 4: The designer's everyday treatments

In order of what office requests need:

1. Face-aware crop and head-height alignment for framed photos.
2. Photo fade into the background; masks (circle, arch); duotone and brand tint; outline and glow on cut-outs.
3. Other sizes of an approved design (story, square).
4. Upscaling of small photos (Real-ESRGAN, BSD-3). The requester is told when a photo is too small.

Always a designer's job (listed in the research): retouching faces or bodies, adding or removing people, logo redraws and calligraphy, and final proofreading of Sorani.

## Phase 5: Measure, then claim

- **Dashboard** per ask:
  - verified-done rate;
  - claimed-done-but-not-done rate (target 0);
  - unrelated-change rate (target 0);
  - rounds to approval;
  - first-time-right;
  - escalations, ranked by op (the catalogue roadmap).
- **Blinded head-to-head with the office designer:**
  - same briefs, photos and requester replies; full loop including revisions;
  - judged by requesters and outside designers;
  - about 200 decisive pairwise judgements to detect a 60/40 preference, and about 100 briefs per arm for rounds-to-approval.
- Approved resolutions feed client rules (the ask and what satisfied it) after approval only.

## Owner decisions and actions

1. Approve ADR-032, which admits a local cut-out model and keeps generative models off photos of people.
2. Raise Docker Desktop memory to 16 GB when convenient. Docker restarts, and Hawa comes back within a few minutes, so choose a quiet time.
3. Free disk space (the Mac is at 98%): see the note of 2026-09-23. The models need about 1–2 GB.
4. For Sewa's current request, one of two routes:
   - Now: the art director opens the latest draft in Canva (task 5261e3ec; the space for the photos was kept), adds both photos and uses Canva's BG Remover. A fresh export is then captured before approval, or delivery would send the file exported before the edit.
   - Later: wait for Phase 1 and replay her request.
