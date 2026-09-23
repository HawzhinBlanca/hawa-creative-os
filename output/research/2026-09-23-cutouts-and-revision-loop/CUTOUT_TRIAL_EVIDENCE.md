# Person cut-out trial on a real request (2026-09-23)

The two panelist portraits from the 2026-09-23 request (task 00d06b2e, SAGACON 2026 invitation) were cut out on the office Mac with three BiRefNet models, CPU only. The photos are client material and are **not** in this repository. They, the mattes and the composites stay in the session scratchpad.

## Set-up

- Host: Apple Silicon Mac, 14 cores, 36 GB. The Docker VM that runs Hawa has 8 CPUs and 8.3 GB (`docker info`).
- Runtime: onnxruntime 1.27 (Python), CPU execution provider, 4 threads, input 1024 × 1024, ImageNet normalisation, sigmoid output.
- Models (rembg release `v0.0.0`, MIT-licensed BiRefNet weights):

| Model | File | Size | sha256 |
|---|---|---|---|
| portrait | `BiRefNet-portrait-epoch_150.onnx` | 972.7 MB | `1ba1c8ff5a7bbfadc8d8d13fb11d7be793f91f23d9d466549e37a854f6668f99` |
| general | `BiRefNet-general-epoch_244.onnx` | 972.7 MB | `58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c` |
| lite (Swin-T) | `BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx` | 224.0 MB | `5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333` |

## Results

| Measure | portrait | general | lite |
|---|---|---|---|
| Inference per photo, 3 runs | 7.0–8.4 s | 6.6–8.4 s | 3.2–4.2 s |
| Model load | 1.9 s | 2.0 s | 1.2 s |
| Peak memory, default settings | 12.3 GB (first model in process) | — | — |
| Peak memory, CPU arena off | 10.4 GB | — | 9.2 GB |
| Peak memory, arena and memory pattern off | 8.4 GB | — | 7.8 GB |

- **Agreement between models** (IoU of alpha ≥ 0.5): photo 1 0.996–0.997; photo 2 0.9965–0.9975.
- **Every matte:** one connected component; foreground 40–50% of the frame; soft edge band 3.6–3.8% of the foreground; touches only the bottom edge (a waist-up portrait).
- **Visual check:** clean cut-outs of both people, hair included. On the photo with a light background, the raw matte left a thin **light halo along the hair**. Foreground-colour estimation (removing the old background's colour from soft edge pixels) plus a 1 px choke removed it, in 0.08 s. A composite on a navy gradient, both people bottom-anchored with a soft shadow, matched the look of the requester's reference.
- **CoreML** (the Mac's accelerator, host only): the provider could run 108 of the export's 4,059 nodes, and the run did not finish within 500 s. It is not an option for this export.
- **The input size is fixed at 1024** in this export (768 was refused), so memory cannot be cut by a smaller input without a re-export.

## What follows

- Quality is sufficient for the office's typical portraits, with foreground estimation mandatory.
- Memory, not speed, is the constraint: at about 8 GB peak the model cannot run inside the current 8.3 GB Docker VM beside Postgres, Restate, Core and the worker. Either Docker gets 16 GB, or a leaner export (native `DeformConv`, reported to cut memory and time; `CUTOUT_MODELS.md` §2) must be proved first.
- The trial covers two photos. The bake-off in the plan (30–50 office photos, BiRefNet_lite-matting and BEN2 added) decides the model.


## Bake-off, 32 images (2026-09-23, after the owner approved ADR-032)

26 freely licensed images from Wikimedia Commons (`BAKEOFF_PHOTO_SOURCES.json`: title, licence, source), plus the 6 distinct images in production requests: two portraits, a reference poster and three designs or screenshots. The set holds single portraits, dark and busy backgrounds, groups of two and three, full-length figures, hijab and hair, close-ups with the top of the head cut off, very small people at a panel table, and paintings, drawings and designs. The last three categories must be refused or kept framed. Each image went through the full engine: matte, cleaning, foreground estimation, face detection and gates, via `services/cutout/hawa_cutout/core.py`.

| Measure | portrait | lite |
|---|---|---|
| Passed gates | 22 of 32 | 23 of 32 |
| Mean time per image, host CPU, 4 threads | 8.7 s | 5.6 s |
| Peak memory | 8.8 GB | 9.1 GB |

- **Verdicts:** every real single or group portrait passed with both models. Failures were the two close-ups whose head is cut off at the top (`head_not_cut`), the panel with tiny people (`resolution`), drawings (`person_found`, `haze`), and posters and screenshots (`person_found`). The two models disagreed on one image: a daguerreotype in its frame, refused as hazy by portrait and passed by lite.
- **Visual check:** the contact sheets (kept in the session scratchpad, since they show client and third-party faces) showed clean hair, veils and hands. At poster size the two models are nearly indistinguishable; portrait is slightly finer on hair.
- **Decision: BiRefNet-portrait.** It has the best published portrait scores and the cleanest training provenance (P3M-10k), and 3 s more per photo does not matter in a run of minutes. Lite stays on disk as a spare.
- **In the shipped container** (`hawa-cutout:1`, Docker VM with 8 CPUs): 10–11 s per photo; 2.2 GB resident when idle. Sewa's two portraits and a two-person photo passed; a drawing was refused with `person_found`. The engine's 9 tests pass inside the image against the pinned model.

| Image | portrait | lite |
|---|---|---|
| c00 | fail: person_found, faces_whole, area, head_not_cut | fail: person_found, faces_whole, area, head_not_cut |
| c01 | pass | pass |
| c02 | pass | pass |
| c03 | pass | pass |
| c04 | pass | pass |
| c05 | pass | pass |
| c06 | fail: person_found, faces_whole, haze | fail: person_found, faces_whole, area |
| c07 | fail: person_found, faces_whole, pieces, haze | fail: person_found, faces_whole, area |
| c08 | pass | pass |
| c09 | fail: person_found, faces_whole, pieces, haze | fail: person_found, faces_whole, haze |
| c10 | pass | pass |
| c11 | fail: resolution | fail: pieces |
| c12 | pass | pass |
| c13 | pass | pass |
| c14 | pass | pass |
| c15 | pass | pass |
| c16 | fail: person_found, faces_whole, head_not_cut | fail: person_found, faces_whole, head_not_cut |
| c17 | pass | pass |
| c18 | fail: haze | pass |
| c19 | pass | pass |
| c20 | pass | pass |
| c21 | pass | pass |
| c22 | pass | pass |
| c23 | pass | pass |
| c24 | pass | pass |
| c25 | pass | pass |
| request 21fd05 | fail: person_found, faces_whole, haze | fail: person_found, faces_whole, haze |
| request 8b94af | pass | pass |
| request a1cdce | pass | pass |
| request b67ac2 | fail: person_found, faces_whole, haze | fail: person_found, faces_whole, area, pieces, haze |
| request c9b48b | pass | pass |
| request f2ed48 | fail: person_found, faces_whole, area, resolution | fail: person_found, faces_whole, pieces, haze |
