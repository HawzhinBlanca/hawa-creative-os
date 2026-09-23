# ADR-032: Pixel-Faithful Photo Treatments and a Request Ledger That Stays Open Until Approval

**Date:** 2026-09-23
**Status:** Accepted by the owner on 2026-09-23 ("approved … start phase 1"). Model chosen after the trial: BiRefNet-portrait (sha256 `1ba1c8ff…6f99`), with the YuNet face detector (sha256 `8f2383e4…52fa4`), served by `services/cutout` in its own container (`infra/docker/Dockerfile.cutout`).
**Amends:** ADR-030 §2.1 ("local LLM/image services are disabled in production"), narrowly: see §2.1 below.
**Plan:** `output/plans/2026-09-23-designer-grade-revisions/PLAN.md`
**Research:** `output/research/2026-09-23-cutouts-and-revision-loop/` (three reports and the cut-out trial evidence)

---

## 1. Context

On 2026-09-23 a requester asked, in two change requests, for the panelists to be cut out of their photos and set on the poster's background, as in the reference she had sent. The pipeline could not do it and could not say so:

1. **No means.** A layout places a photo only as a rectangle filled with the whole picture. The brief had even described the reference as "paired cutout portraits"; the first draft still claimed "your reference design followed".
2. **No honest exit.** The edit model wrote "this schema has no background-removal or mask field … cutout processing remains required" into its own notes. It then enlarged the photos, moved the text and recoloured the date, and the requester was told "your change made to the same design (312 × 326.42 at (65, 672) …)".
3. **State lost across rounds.** Her second change looked for photos one design back, found none, and the edit removed both portraits.

Items 2 and 3 were fixed the same day. This ADR decides how the missing means are added, and how requests are carried until the requester approves.

## 2. Decisions

### 2.1 Photos of real people are processed only by pixel-faithful operations

- A **cut-out** is made by a local segmentation/matting model (BiRefNet family, MIT licence) that only decides which pixels are background. Every pixel kept is the photograph's own. It runs on the office machine, so client photos go nowhere new.
- **Generative image models** (gpt-image-2.5, Gemini, FLUX and similar) are **never applied to a photo of a real person**. They redraw the whole image: the person comes back subtly different (identity drift is measured in the literature, including for GPT-Image), and their transparency is reported to leave grey halos and not-quite-opaque subjects. They remain allowed for background art, as ADR-030 permits.
- **Canva's background remover** stays the art director's manual tool in the editor. Canva's API version (`POST /v1/image-transformations`, preview since 2026-09-17) is not the pipeline's engine:
  - it returns only a 15-minute thumbnail, so the pipeline could not lay out, render or check the design around the real cut-out;
  - the draft reaches Canva as an imported PPTX, which cannot reference a Canva asset;
  - it is a preview API, spends Canva AI credits, and needs `asset:read`/`asset:write` scopes that Hawa's connection does not hold.

  It may be revisited when it leaves preview and offers a full-resolution result.
- **Scope of the amendment to ADR-030:** a local model is admitted **only** for deterministic pixel analysis of client-supplied images: segmentation, matting and face detection. No local generation, no local language model. Every such model is pinned by sha256, licence-checked (commercial use of the weights), and recorded in the model registry with its version.
- **Every derived image keeps its original.** A cut-out is a new asset with provenance: source hash, model, model hash, parameters and QA result. A cut-out that fails its checks is never placed silently: the design falls back to the framed photo, and the requester and the art director are told.

### 2.2 A photo in a layout has a treatment

`photoElementSchema` gains `treatment: 'framed' | 'cutout'` (default `framed`), and later `mask`, `fade`, `shadow` and group alignment. A cut-out is placed by its alpha, not its box: overlap and contrast checks use the person's silhouette. It is transferred to Canva as a transparent PNG, with the person and their shadow as separate layers, so it stays editable. The brief chooses `cutout` when the request or the reference calls for it.

### 2.3 Change requests become a ledger, and "not possible" is a legal answer

- Each reply is split into atomic **asks**. Each ask maps to an operation from a typed **operation catalogue**, or to `unsupported` / `needs_clarification`.
- The model proposes operations; deterministic code applies them. Anything outside the declared targets is reverted by a structural diff.
- An ask's status (`open → applied → verified | not_done → escalated`, `not_possible → escalated`, `verified → confirmed` on approval) is read from the design itself, never from the model's account of it.
- The ledger lives with the design lineage (the parent chain). Every open and verified ask is sent to every later edit, so nothing asked earlier is lost or undone.
- The requester's message is built only from ledger rows. It never contains coordinates or model names.

### 2.4 The loop stays with the requester until they approve

- Only an explicit **Approve** from the requester (a button) closes their side. The art director's approval in Hawa Desk (ADR-022) still gates delivery.
- An ask that is `not_possible`, fails verification twice, or is still open after three rounds is escalated to a designer. The designer gets a hand-off packet: the ledger, the requester's words, the photos and reference, before/after renders, and the Canva link. The requester is told who has it.
- Ambiguous asks get one clarifying question with options. Otherwise the edit acts and states its assumption.

## 3. Consequences

- **Positive.**
  - Cut-out requests, and the reference designs that use cut-outs, become possible without sending client photos anywhere new.
  - No request is silently dropped or replaced.
  - The unsupported asks the office receives become a measured roadmap.
- **Negative.**
  - The cut-out model needs about 8 GB of memory at peak (measured, stock export). The Docker VM must grow from 8.3 GB to 16 GB, or a leaner export must be proved first.
  - A cut-out adds about 4–8 s per person.
  - The model files add 0.2–1 GB to the image or a mounted volume.
- **Risks.**
  - Hair and edge quality on poor phone photos.
  - Licences of training data behind MIT weights (BiRefNet-portrait has the cleanest provenance).
  - Memory pressure on Postgres if the model runs beside it without limits.

  Mitigations are in the plan: a bake-off, QA gates, one inference at a time, and a container memory limit.
