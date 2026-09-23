# Person cutout for Hawa: research report (2026-09-23)

Every claim below carries a numbered source; the list at the end gives URLs and dates. Where I could not verify something I say so. I did not download any model or run any benchmark. The host facts marked "measured today" come from `sysctl` and `docker info` on this Mac.

**In short:** use **BiRefNet_lite-matting** (MIT licence, 44.4M parameters), exported by us to ONNX with native DeformConv. Keep **BiRefNet-portrait** (MIT, 0.2B parameters) as the fallback and second opinion. Refine edges with foreground-colour decontamination, not erosion. Gate each cutout with face coverage, component checks and agreement between the two models. Hand Canva each person as a separate PNG with any fade built into its transparency. Do not use generative models on real faces.

## 1. State of the art: the candidates

| Model | Licence | Size / ONNX | Input | Reported quality | CPU time reported |
|---|---|---|---|---|---|
| **BiRefNet** (general, Swin-L) | MIT [1] | ~0.2B params; official ONNX 972.7 MB fp32 [2]; onnx-community fp16 489.7 MB [6] | 1024² | DIS-VD S .911, wF .875 [1] | Not published. ONNX costs about 90% more time than PyTorch even on a GPU [1] |
| **BiRefNet-portrait** | MIT [3] | 0.2B; ONNX 972.7 MB [2][8], fp16 489.7 MB [6] | 1024² | TE-P3M-500-P S .983, MAE .006 [3] | — |
| **BiRefNet-matting** | MIT [4] | 0.2B; ONNX 972.7 MB (2024-10-28) [2] | 1024² | TE-P3M-500-NP S .979, MSE .003 [4] | — |
| **BiRefNet_lite-matting** (Swin-T) | MIT [5] | 44.4M; 89 MB fp16 safetensors; **no ONNX published** [5] | 1024² | TE-P3M-500-NP S .978; TE-AM-2k S .970 [5] | See lite row below |
| BiRefNet_lite (general) | MIT | 224 MB fp32 / 114.5 MB fp16 [6] | 1024² | DIS-VD S .882 [1] | **2.4 s** at 1024 with a native-DeformConv export; stock export 6.5 s and **10.5 GB peak memory** (Intel Core Ultra 9 185H) [7] |
| BiRefNet_HR / HR-matting / dynamic | MIT | 1098.9 MB ONNX [2]; dynamic 972.5 MB (2026-09-01) [6] | 2048² / 256–2304 | Released Feb–Mar 2025 [1] | Too large for 600–1500 px phone photos |
| **BRIA RMBG-2.0** | **CC BY-NC 4.0; commercial use needs a paid Bria agreement** [12] | BiRefNet architecture; ONNX 1024 MB fp32, 514 MB fp16, 366 MB int8 [12] | 1024² | Bria's own benchmark: 90% vs BiRefNet 85% [14] | One user: 20 s PyTorch vs 37 s quantized ONNX on CPU, CPU model not stated (2024-11-20) [13] |
| **BEN2** base | MIT; a stronger "full" model is sold commercially [15] | 94.6M; `BEN2_Base.onnx` 222.9 MB [15] | not stated | BEN paper (Jan 2025), DIS-VD: Fβmax .919, Fβω .896, MAE .027 vs BiRefNet .897/.863/.036 [15] | not stated |
| InSPyReNet (transparent-background) | MIT [17] | no official ONNX | 1024 base / 384 fast | DIS-VD Fβmax .889 [16] | — |
| ISNet (DIS) | Apache-2.0 code; DIS5K has its own terms of use | 178.6 MB ONNX [8] | 1024 | DIS-VD Fβmax .791 [16] | — |
| U²-Net human seg | Apache-2.0 | 176 MB ONNX [8] | 320² | 2020-era; loses fine hair [48] | fast |
| MODNet | Apache-2.0 [18] | ONNX 25.9 MB, int8 6.6 MB [18] | ~512 | 67 fps on a 1080Ti GPU [18] | fast, but old |
| ViTMatte (refiner, needs a trimap) | MIT code [19] | ONNX small 114 MB, base 398 MB (rembg release 2026-08-17) [8] | trimap | Comp-1k SAD 21.46 (S) / 20.33 (B) [19] | ~2.1 s per portrait, hardware not stated [10] |
| SAM 2.1 | Apache-2.0 [21] | hiera-tiny ONNX encoder 134 MB + decoder 21 MB [21] | 1024 | coarse instance masks | — |
| SAM 3 / 3.1 | SAM License: commercial use allowed, military/ITAR banned [22] | 848M [49]; gated | — | text prompts ("person") | heavy |
| withoutBG open weights | Apache-2.0 plus Meta DINOv3 licence [23] | 455 MB ONNX | **448² only** | none published | — |
| MatAnyone 2 (CVPR 2026) | **S-Lab: non-commercial** [24] | video | — | includes a learned matte-quality evaluator | — |

**Licence traps**
- **rembg made `bria-rmbg` its default model on 2026-08-17** [11]. Its own PR says RMBG-2.0 needs a paid agreement for commercial use. Always pass `-m` explicitly.
- ViTMatte weights trained on Adobe Composition-1k fall under Adobe's non-commercial dataset licence [20]. I could not verify the Distinctions-646 terms.
- **Training data is not the same as the weights licence (legally uncertain).** BiRefNet-matting trained on AIM-500, AM-2k, Distinctions-646, HIM2K and others [4]. BiRefNet-portrait trained only on P3M-10k, which is released under an MIT-style agreement [50], plus "TR-humans", whose source I could not find [3]. Portrait therefore has the cleaner provenance.

## 2. What to use for people on CPU

- **Primary: BiRefNet_lite-matting.** On the portrait test set it scores almost the same as the full matting model (S .978 vs .979), with about a quarter of the parameters [4][5]. There is no ONNX, so we export it once, offline, in Python:
  - Use the `export_birefnet.py` approach from [7]. It maps `deform_conv2d` to native ONNX `DeformConv` (opset 19), allows dynamic input sizes, and gave output identical to PyTorch at 1024.
  - Weights: https://huggingface.co/ZhengPeng7/BiRefNet_lite-matting (89 MB).
  - For a quick start, a ready native-DeformConv export of the general lite model is at https://huggingface.co/senty-au/BiRefNet_lite-ONNX-dynamic (`onnx/model.onnx`, 180.8 MB, sha256 `1e0da42f…9391`, uploaded 2026-09-18) [7]. Check the hash before using it; it is a third-party binary.
- **Fallback and second opinion: BiRefNet-portrait.** Official ONNX files:
  - https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-portrait-epoch_150.onnx (972.7 MB)
  - the same file at https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-portrait-epoch_150.onnx
  - https://huggingface.co/onnx-community/BiRefNet-portrait-ONNX: `onnx/model.onnx` 972.7 MB, `model_fp16.onnx` 489.7 MB [2][8][6].
  - Re-export it with native DeformConv too.
- **Candidate for the bake-off:** `BEN2_Base.onnx` (MIT, 222.9 MB) at https://huggingface.co/PramaLLC/BEN2. Its architecture and training data are different, so it disagrees with BiRefNet more independently.
- **fp16 and quantized files:**
  - ONNX Runtime's CPU provider does not run float16 operations [25]. The fp16 files only save disk space; conversions can take about half the run time [25]. Do not use them on CPU.
  - The native-export author found dynamic int8 quantization gave no speed-up [7].
  - On RMBG-2.0, quantized ONNX was slower on CPU (37 s vs 20 s) [13].
  - I found no published measurement of int8 edge quality for BiRefNet. Treat it as untested.
- **Docker limits:**
  - `onnxruntime-node` 1.30.0 (2026-09-14) supports Linux arm64 on CPU only. CoreML is available only on native macOS [26].
  - Measured today: the Docker VM has **8 CPUs and about 8.3 GB of RAM**, on an M4 Max host. The stock lite export peaked at 10.5 GB at 1024 [7], so it would likely run out of memory. The native-DeformConv export is required, or Docker needs more memory. Run one inference at a time.

## 3. Edge quality

- **Colour spill:** making an edge pixel semi-transparent does not remove the old background colour mixed into it. You have to estimate the true foreground colour [9].
  - rembg added `-dc` on 2026-08-17. It keeps the model's alpha and runs pymatting's `estimate_foreground_ml` [9].
  - On two portraits, contamination fell from 87.2 to 49.2 at a cost of 0.09 s [10].
  - `estimate_foreground_ml` implements "Fast Multi-Level Foreground Estimation" (Germer et al., ICPR 2020; MIT) [27].
  - Forte's "Approximate Fast Foreground Colour Estimation" (ICIP 2021 best industry paper) is about 11 lines of NumPy/OpenCV blur fusion [28]. It is easy to port to Node. Its repo has no licence file, so reimplement it from the paper.
- **Mask refinement:** the guided filter (He et al., ECCV 2010) turns a binary mask into a soft matte using the photo as a guide ("guided feathering") [29].
  - ViTMatte refinement from a trimap recovered about 17% more soft hair pixels than pymatting's closed-form solver, at 2.1 s [10]. Its licence caveat is in §1.
- **Erosion and feathering:** use a 1 px choke plus a 1 px blur only on hard contours, never on hair. A composite tutorial recommends a 2–5 px smart radius and a 1 px mask blur [37].
- **What professional tools do:**
  - Photoshop's Select and Mask has Refine Hair and "Decontaminate Colors", which replaces fringe colour with nearby fully selected colour in proportion to edge softness [30]. Select Subject and Remove Background offer a slower, more detailed cloud mode [30].
  - Photoroom's API applies foreground estimation by default [28].
  - Canva's BG Remover comes from Kaleido (remove.bg), acquired in February 2021 [31]. Its method is not published.

## 4. Automatic QA without a human

I found **no commercially usable, published no-reference matte-quality model**:
- MatAnyone 2's evaluator uses DINOv3 plus a decoder and outputs a per-pixel reliable/erroneous map, but it is non-commercial [24].
- SAM's predicted-IoU score applies only if SAM is in the pipeline.

So use deterministic gates. The thresholds below are my suggested starting points (marked ^[inferred]). Calibrate them on about 50 office photos.

| Gate | Rule |
|---|---|
| Faces | Detect faces with YuNet (MIT, 232 KB ONNX, box plus 5 landmarks) [32]. Each target face: mean alpha ≥ 0.97 over the central 70% of the box. Faces outside the target must have alpha < 0.1, which catches bystanders and posters in the background. Face count must equal the expected number of people. |
| Area | Foreground (alpha ≥ 0.5) between 8% and 80% of the image. |
| Components | After dropping specks smaller than 0.2% of the image, component count ≤ number of people, and each person's largest component holds ≥ 95% of their area. |
| Borders | Foreground touching the top edge (> 2% of its length) means the head is cropped: flag it. Touching a side edge (> 20%) suggests background attached. Touching the bottom is expected. |
| Haze | Soft pixels (0.05 < alpha < 0.95) ≤ 6% of the image. Faint alpha (0.02–0.2) more than 3% of the long side away from the contour ≤ 0.5% of the image. In a comparison of two segmentation models (BiRefNet vs U²-Net), the share of ambiguous edge pixels fell from 2.56% to 0.86% [48]. |
| Agreement | Lite vs portrait: IoU at alpha ≥ 0.5 must be ≥ 0.95; IoU in the boundary band ≥ 0.80; mean alpha difference ≤ 0.03. For reference, one model at different resolutions scored 0.975–0.999 IoU [7]. |
| Halo | Composite onto black and onto white; the 2 px ring outside the edge must differ in luminance by ≤ 8/255. |
| Resolution | Upscaling to the target face height must be ≤ 1.5×; otherwise ask for a better photo. |
| Pixel-faithful | Wherever alpha ≥ 0.98, the output colour must equal the source colour exactly (difference 0) before any tone adjustment. This proves nothing was redrawn. |

If a gate fails: rerun with the fallback model. If it still fails, deliver to Canva with a "check cutout" comment, or ask the requester for another photo.

**Several people in one photo:**
- Split the combined mask by connected components using the face boxes.
- If people touch, run SAM 2.1-tiny (Apache-2.0) with person boxes from YOLOX or RT-DETR (both Apache-2.0) [21][34]. Intersect SAM's coarse mask with BiRefNet's fine alpha.
- Avoid Ultralytics YOLO (AGPL-3.0) [34] and the InsightFace/SCRFD weights (non-commercial) [33].

## 5. Compositing so it looks designed

These are designer practice [37] plus my own rules ^[inferred]:
- **Scale:** normalise every panelist to the same face-box height (±3%); a lead speaker may be 1.1–1.2×. Align eye lines within ±1% of canvas height, or stagger them clearly (≥ 4%). A near miss looks like a mistake.
- **Bottom edge:** bleed the cutout off the canvas bottom, or sit it on a band. If the cut would show, fade alpha over the bottom 12–20% of the cutout. Build the fade into the PNG, because Canva has no per-image gradient mask, only overlay workarounds [38].
- **Overlap:** primary person in front, others fanning out behind. Bodies may overlap up to about 20% of shoulder width; faces never overlap. Leave at least 0.6 face-widths between faces.
- **Shadow:**
  - The tutorial [37] recommends a two-layer contact shadow in Multiply mode, with the colour sampled from the background (not black) and a small darker shadow at the contact point.
  - For waist-cropped people there is no ground to stand on. Use a soft ambient shadow instead (blur 3–5% of cutout height, opacity 20–35%) as a **separate PNG** in Canva so the art director can move or delete it.
- **Rim light:** off by default. The recipe is Screen mode at 40–60% [37].
- **Tone:**
  - Harmonizer's result: brightness, contrast, saturation, temperature, highlight and shadow alone are enough to harmonise a composite [35].
  - But its weights are CC BY-NC-SA [35]. PCT-Net's code is MPL-2.0, but its weights were trained on iHarmony4, whose licence I could not confirm [36].
  - So compute capped white-box adjustments ourselves: first make the panelists match each other (face luminance gain ≤ ±15%, a small temperature shift, no hue change on skin), then match the background at ≤ 20% strength.

## 6. Hosted alternatives

| Service | Price | Notes |
|---|---|---|
| **Canva REST "image transformations"** (preview, launched **2026-09-17**) | Uses the user's AI credits | `POST /v1/image-transformations` with `{"type":"background_removal"}`. Needs the `background_removal` capability (Canva Pro and similar plans), 20 requests/min, output ≤ 10 MP [39]. The documented result is a Canva asset with only a **thumbnail URL**, so we cannot QA the full-resolution file. Preview APIs can change without warning [39]. **The Canva MCP server has no background-removal tool or operation** [40]. |
| Photoroom | $0.02/image (Basic plan); 1,000 watermarked sandbox calls/month [41] | Images discarded after each API call; no training without consent; SOC 2 Type 2 [41]. |
| Bria RMBG-2.0 via fal | $0.018/image [43] | The commercial licence comes with the API [12]. |
| remove.bg | ~$0.20/image on plans (third-party figure) [42] | **API moves to Leonardo.Ai on 2026-12-01**, with auth, format and storage changes [42]. Do not build on it now. |
| Clipdrop | ~$0.07–0.09 per credit (third-party figure) [44] | Now under Jasper. |
| fal BiRefNet v2 | Page showed "$0 per compute second"; **not verified** [43] | Offers General/Portrait/Matting/Dynamic; foreground refinement on by default. |

## 7. Why not generative models

- **Identity drift is measured, not hypothetical.** The FLUX.1 Kontext paper tracked AuraFace similarity over successive edits and reported Kontext drifts only *more slowly* than GPT-Image-high and Gen-4 [47]. Every model drifts.
- **Edits regenerate the whole image** according to OpenAI's edit reference, and `input_fidelity` is ignored on `gpt-image-2` [45].
- **Transparency:**
  - OpenAI supports `background:"transparent"` on gpt-image-2.5 (Sunburst/Flare) and in preview on gpt-image-2 (since 2026-08-20) [45].
  - Users report alpha values of 253–254 instead of 255, grey halos, and leaked colour data [45].
  - Gemini image models output only RGB, with no alpha [46].
  - I found no Black Forest Labs documentation of alpha output for FLUX; third-party sources say none exists.
- A hallucinated alpha is not a matte of the real photo, and it breaks our pixel-faithful gate.

## Recommendation

1. **Models:** BiRefNet_lite-matting with a native-DeformConv ONNX export, running under `onnxruntime-node` at 1024². BiRefNet-portrait (same export) as fallback and second opinion. Run a bake-off with BEN2 base on 30–50 office photos before locking this in. Never use RMBG-2.0 or rembg's default without a Bria licence.
2. **Refinement:** sigmoid, then upsample to the original size, then a guided filter only in the uncertain band, then Forte/Germer foreground estimation, then clamp alpha below 0.02 to 0 and above 0.98 to 1. Remove specks, but fill holes only when they don't touch the border. Keep ViTMatte off until legal clears the weights.
3. **QA:** the gates in §4, with fallback and escalation on failure.
4. **Compositing:** the rules in §5. Each person, their shadow and any fade go to Canva as separate editable PNG assets.
5. **Hosted fallback:** Canva's image-transformation API, only when local gates fail and the user has credits, and treat its output as not QA'd.
6. **Expected latency per person** in the 8-vCPU container:
   - YuNet: milliseconds [32].
   - Lite model: about 2–3 s (extrapolated from 2.4 s on x86 [7]; **not measured on M4/Docker**).
   - Foreground estimation: about 0.1 s [10].
   - Portrait second opinion: unmeasured. My estimate is 8–20 s, based on the 20 s RMBG-2.0 data point [13].
   - Total: about 3–4 s per person without the second opinion, 12–25 s with it. A 4-person poster takes roughly 15–100 s.
   - Measure all of this in the bake-off.

## Sources (accessed 2026-09-23 unless dated)

[1] https://github.com/ZhengPeng7/BiRefNet · [2] https://github.com/ZhengPeng7/BiRefNet/releases/tag/v1 (assets 2024-08-18 to 2025-02-12) · [3] https://huggingface.co/ZhengPeng7/BiRefNet-portrait · [4] https://huggingface.co/ZhengPeng7/BiRefNet-matting · [5] https://huggingface.co/ZhengPeng7/BiRefNet_lite-matting (2025-04-22) · [6] https://huggingface.co/onnx-community/BiRefNet-portrait-ONNX, …/BiRefNet_lite-ONNX, …/BiRefNet_dynamic-1024x1024-ONNX (sizes from the HF API) · [7] https://huggingface.co/senty-au/BiRefNet_lite-ONNX-dynamic (2026-09-18) · [8] https://github.com/danielgatis/rembg, releases/tag/v0.0.0 · [9] https://github.com/danielgatis/rembg/pull/843 (2026-08-17) · [10] …/pull/846 (2026-08-17) · [11] …/pull/845 (2026-08-17) · [12] https://huggingface.co/briaai/RMBG-2.0 · [13] https://huggingface.co/briaai/RMBG-2.0/discussions/10 (2024-11-20) · [14] https://blog.bria.ai/benchmarking-blog/brias-new-state-of-the-art-remove-background-2.0-outperforms-the-competition · [15] https://huggingface.co/PramaLLC/BEN2 ; https://arxiv.org/html/2501.06230v1 (2025-01) · [16] https://arxiv.org/html/2410.10105v1 · [17] https://github.com/plemeri/transparent-background · [18] https://github.com/ZHKKKe/MODNet ; https://arxiv.org/abs/2011.11961 ; https://huggingface.co/onnx-community/modnet-webnn · [19] https://github.com/hustvl/ViTMatte · [20] https://github.com/Yaoyi-Li/GCA-Matting · [21] https://github.com/facebookresearch/sam2 ; https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX · [22] https://github.com/facebookresearch/sam3/blob/main/LICENSE · [23] https://huggingface.co/withoutbg/withoutbg-openweights-onnx · [24] https://arxiv.org/html/2512.11782 ; https://github.com/pq-yang/MatAnyone2 · [25] https://onnxruntime.ai/docs/performance/model-optimizations/float16.html ; https://github.com/microsoft/onnxruntime/issues/13838 · [26] https://github.com/microsoft/onnxruntime/blob/main/js/node/README.md · [27] https://github.com/pymatting/pymatting ; https://arxiv.org/abs/2006.14970 · [28] https://github.com/Photoroom/fast-foreground-estimation · [29] https://link.springer.com/chapter/10.1007/978-3-642-15549-9_1 · [30] https://helpx.adobe.com/photoshop/using/select-mask.html ; https://helpx.adobe.com/photoshop/desktop/make-selections/automatic-color-based-selections/improved-select-subject-and-remove-background-results.html · [31] https://techcrunch.com/2021/02/24/canva-acquires-background-removal-specialists-kaleido/ · [32] https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet ; https://huggingface.co/opencv/face_detection_yunet · [33] https://github.com/deepinsight/insightface · [34] https://github.com/Megvii-BaseDetection/YOLOX ; https://github.com/lyuwenyu/RT-DETR ; https://github.com/ultralytics/ultralytics · [35] https://github.com/ZHKKKe/Harmonizer ; https://arxiv.org/abs/2207.01322 · [36] https://github.com/rakutentech/PCT-Net-Image-Harmonization · [37] https://photoshoptutorial.com/posts/why-your-composites-look-fake-and-the-blending-workflow-that-fixed-mine/ (2026-08-03) · [38] https://saltfish.ai/tutorials/canva/how-to-fade-photo-edges · [39] https://www.canva.dev/docs/apps/rest-apis/reference/image-transformations/create-image-transformation-job/ ; changelog in https://www.canva.dev/docs/apps/llms-full.txt · [40] https://www.canva.dev/docs/mcp/tools/ ; https://glama.ai/mcp/connectors/com.canva.mcp/canva/tools/perform-editing-operations · [41] https://www.photoroom.com/api/pricing ; https://www.photoroom.com/platform/security · [42] https://www.remove.bg/faq ; https://ai.nero.com/blog/remove-bg-is-moving-to-canva-what-changes-and-what-to-use-instead/ (2026-07-29) ; https://costbench.com/software/ai-media-apis/remove-bg-api/ · [43] https://fal.ai/models/fal-ai/bria/background/remove ; https://fal.ai/models/fal-ai/birefnet/v2/llms.txt · [44] https://clipdrop.co/apis/docs/remove-background ; https://aisotools.com/pricing/clipdrop · [45] https://developers.openai.com/api/reference/python/resources/images/methods/edit ; https://community.openai.com/t/transparent-backgrounds-are-now-available-in-preview-for-gpt-image-2-in-the-api/1391541 (2026-08-20) · [46] https://transparify.app/blog/gemini-transparent-background · [47] https://arxiv.org/html/2506.15742 (2025-06) · [48] https://huggingface.co/fernandotonon/QtMeshEditor-birefnet-onnx · [49] https://invideo.io/blog/ai-background-removal-models/ (2026-08-18) · [50] https://github.com/JizhiziLi/P3M
