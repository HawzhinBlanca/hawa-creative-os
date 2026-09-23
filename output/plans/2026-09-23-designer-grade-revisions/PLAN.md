# Designer-grade revisions: cut-outs, a request ledger, and a loop that stays until approval

**Date:** 2026-09-23 · **Decision record:** `adrs/032_photo_cutouts_and_request_ledger.md` (Accepted 2026-09-23) · **Research:** `output/research/2026-09-23-cutouts-and-revision-loop/`

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

## Status, 2026-09-23 night (owner approved ADR-032 and "continue the not done items")

| Item | State | Where / proof |
|---|---|---|
| 1.1 Bake-off | Done on 32 images (26 Commons, 6 from requests). Every real portrait passed; drawings, posters, heads cut off at the top and tiny figures refused. BiRefNet-portrait chosen. BiRefNet_lite-matting and BEN2 were **not** tried: the stock lite and full models already separate cleanly | `CUTOUT_TRIAL_EVIDENCE.md` |
| 1.2 Cut-out service | Done and deployed: its own container (`hawa-cutout:1`), 12 GB limit, internal network only, model pinned by sha256; each photo cut once and stored (`hawa.photo_cutouts`) | `services/cutout`, migration 014, `photo-cutouts.test.ts` |
| 1.3 QA gates | Done: person found, face whole, area, pieces, haze, head not cut, resolution, expected people; pixel-faithful by construction. The two-model agreement and halo gates were **not** built: foreground estimation removes the halo, and one model is loaded | `services/cutout/tests` (run in the image by the deploy) |
| 1.4 Layout treatment | Done: people stand on the bottom edge, heads matched by face size, side by side, clear of the text; the checks hold a cut-out to its height | `photo-cutout.ts`, `arrangeCutouts` |
| 1.5 Canva transfer | Done and proved live: a transparent figure imported through the pipeline's PPTX path came back from Canva with the background showing through its transparent pixels (sampled 10,42,107 = the navy background). Test design "Hawa test: cut-out transparency" left in the office's Canva | `canva-alpha-probe`, 2026-09-23 |
| 1.6 Brief and edit | Done and proved live: Sewa's own message on her own design (production pipeline, nothing sent) gave both panelists cut out, standing on the bottom edge, text spread; both asks recorded done | `change-request-honesty.test.ts`; before/after/reference image |
| 1.7 Owner | Done: ADR approved, Docker memory raised | |
| 2.1 Ledger | Done, changed from the plan: the asks are recorded on each run (`stages.directed.asks`, each with its kind of change, outcome, reason, reading and visual check) and read along the revision chain, not kept in a new table. Hawa Desk shows the ledger in the task view ("What the requester asked"), and `GET /tasks/:taskId/asks` returns it | `ask-ledger.ts`, `AskLedger.tsx`, `ask-ledger.test.ts` |
| 2.2 Operation catalogue | Partly done: each ask is classified into the catalogue's operations (`EDIT_OPS`), recorded, and counted by operation in the metrics (the roadmap). Wording changes are applied by code from the client's own words. The other operations are still layout edits proposed by the model and held by the guards below, not applied op by op | `applyCopyEdits`, `EDIT_OPS` |
| 2.3 Structural diff | Done: colours and type of anything not asked about are restored; anything not asked about that moved or resized is put back (all at once, else one at a time) when the design still passes its checks; what had to move to make room stays and the requester is told ("To make room, this also moved: the date") | `movedUntargeted`, `withPlacesOf`, `edit-guards.test.ts` |
| 2.4 Carry-forward | Done: every later round is told what earlier rounds made, and keeps any wording an earlier round changed | `earlierAsks`, `effectiveCopy` |
| 2.5 Semantic check | Done as advice: one yes/no look at before and after per edit, per ask. It never changes the outcome the requester reads; its disagreements go to the office summary, the Desk ledger and the metrics (`visualCheck.doneButNotSeen`). Agreement with the art director on 50 real asks is still to be measured before it is trusted | `visualCheck`, `edit-guards.test.ts` |
| 3 Buttons | Done: Approve, Change something, Ask a designer, under every ready draft; none approves a design (the Desk still does) | `requester-buttons.test.ts` |
| 3 Escalation | Done: a change that is not possible, "Ask a designer", round 3 of changes, and a requester who sounds frustrated each alert the office with what was asked | `composeDesignerHandoff` |
| 3 Reminders | Done: day 1 and day 5, office hours only, never for an answered or replaced draft, only for drafts sent after 2026-09-24 06:00 UTC | `draft-reminders.test.ts` |
| 3 Clarifying questions | Done: an ask that could mean visibly different designs gets one question with 2–3 answer buttons before anything is paid for; the whole request waits, the task is paused (not "operator required"), and a tapped answer or a reply in the requester's words starts the change again on the same design, never to be asked again. An ask read one way says how ("read as: bigger photos") | `clarifying-questions.test.ts` |
| 4.1 Face-aware crop | Done: framed photos are cropped around the faces in the preview and the deck alike (deployed), and framed portraits side by side show their heads at one size, each cropped tighter (zoom) up to where it would look soft. Photos stored on their side keep the centred crop | `photo-crop.test.ts`, `photo-treatments-core.test.ts` |
| 4.2 Treatments | Done: circle and arch masks, edge fades, black and white, duotone and tint, outline and glow around cut-out people, and a tighter crop (zoom). Each is drawn once as SVG, inline in the preview and rasterised into the deck, so the preview and Canva agree within a few colour levels; untreated photos are unchanged byte for byte. Outlines and glows are their own layers in Canva, so the client can delete them. The edit can set and remove each; colours are held to the brand palette | `photo-treatments.ts` (30 tests), `photo-treatments-core.test.ts`; proof sheet on public portraits, 2026-09-23 |
| 4.3 Other sizes | Done: after approving, the requester can ask for the story, square or landscape version; the approved design is laid out again for the format (a story keeps text in the phone's safe zone) and checked by the same gates, as its own draft | `other-sizes.test.ts` |
| 4.4 Small photos | Done differently: no upscaling model, because on a person's photo it would invent their face (ADR-032); the requester is told when a photo is shown 1.6 times or more beyond its own pixels and may look soft | `softPhotoNotes` |
| 5 Measurement | Done: `GET /system/revision-metrics` counts asks by outcome and by kind, questions asked and answered, edits that moved something to make room, the visual check's agreement and "done but not seen", frustrated requesters, requester approvals, hand-offs, reminders and cut-outs. The blinded comparison with the office designer needs the designer and judges: protocol below, **not run** | `revision-metrics.test.ts` |

## Blinded comparison with the office designer: protocol (written 2026-09-23, not run)

The claim "better than the office designer" is decided by people who cannot tell which design is which, never by a model judge: VLM judges do not agree with designer panels (TASTE, May 2026) and favour their own outputs.

1. **Sample, fixed before anything is made.** 50 real office requests from the past month, chosen to cover what the office gets: events with speaker photos, bilingual Sorani and English copy, text-heavy notices, a reference to follow. Each has its brief, photos, reference and the requester's replies as they were sent.
2. **Two arms, same inputs.** Hawa's full loop (drafts, questions, changes, approval) and the office designer working from the same brief, photos, reference and replies. Each arm's final design is exported at the same size as a PNG with its metadata removed.
3. **Judges.** The requesters who sent the briefs (4 to 6) and 3 designers from outside the office. Each pair is shown side by side in random order, with no names, and each judge picks one or says "no preference". Every pair is judged by at least 4 judges.
4. **Primary outcome.** The share of decisive judgements that prefer Hawa, with a 95% confidence interval. About 194 decisive judgements detect a 60/40 preference with 80% power at α = 0.05 (two-sided), so 50 pairs × 4 judges is the minimum. "Better" is claimed only if the lower bound is above 50%. The tie rate is reported beside it.
5. **Secondary outcomes.** Rounds to approval, time to first draft and to approval, copy errors (character by character against the brief), and brand-rule violations, per arm. Detecting a difference of half a round needs about 100 briefs per arm; with 50, it is reported as an estimate, not a finding.
6. **Pre-registered.** The sample, judges, analysis and the claim's threshold are written down before any pair is judged. Pairs the judges saw before (a design they received themselves) are marked and reported separately.

Needed from the office: the designer's time for 50 designs, the requesters' and outside designers' time to judge, and permission to show the designs to the outside judges. The judging page (random order, one pick per pair, results kept per judge) can be built once the pairs exist.
