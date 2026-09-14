# T07: Art Provider Proof & Verification

**Date:** 2026-09-14  
**Branch:** `studio-v2`  
**Task:** T07 (Art Provider — `gemini-image-provider.ts` & `color-science.ts`)  
**Status:** **COMPLETE / ACCEPTED (Live Gemini 3 Pro Image generation verified with authentic 2K bytes, CIEDE2000 dominant-color compliance, and Claude Fable 5.1 vision verification)**

---

## 1. Overview & Architecture

Per ADR 029 (Section 5.5) and `GEMINI_TASK_SHEET.md`, the Art Layer produces text-free, palette-conditioned imagery for Design Studio v2 concepts:
1. **Prompt Composition (P7):** Appends a deterministic contract suffix to concept art prompts, enforcing zero text/digits/logos/faces, palette bounds, calm region designation, and aspect ratio.
2. **Resolution & Format:** Requests 2K resolution at the nearest supported aspect ratio (`4:5`, `1:1`, `16:9`, etc.) from Gemini 3 Pro Image (`gemini-3-pro-image`).
3. **Hard Verification Check A (Dominant Colors):** Quantizes image colors into 5 dominant clusters using 5-bit RGB histogram binning, converting to CIE $L^*a^*b^*$ under D65 illuminant, and verifying each cluster satisfies $\Delta E_{2000} \le 25$ against the brand palette OR is a soft neutral ($C^* < 8$).
4. **Hard Verification Check B (Vision Guardrail):** Performs an isolated zero-shot multimodal vision check with `claude-fable-5-1` to guarantee the image contains no letters, numbers, typography, logos, emblems, flags, faces, or people.
5. **Degradation Ladder & Procedural Fallback:** Allows at most two generation attempts before seamlessly falling back to deterministic procedural motifs (`motifs.ts`) with `artFallback: 'procedural'` and zero cost.

---

## 2. API Contracts & Authentic Live Receipts

### 2.1 Gemini 3 Pro Image Generation API Request
- **Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent`
- **Authentication:** `x-goog-api-key` / `?key=` query parameter
- **Composed Prompt Sent:**
```text
Abstract minimalist Kurdish mountain horizon at dawn, layered architectural geometry and subtle atmospheric mist in deep navy and sky ice blue with delicate gold morning illumination

Photographic or painterly still image, no text of any kind, no letters, numbers, typography, logos, emblems, seals, flags, coats of arms, no people, faces or hands. Palette limited to #0A1628, #1E3A5F, #4770A3, #D4E2F0, #F7B500, #FDF8F3, #FFFFFF with soft neutrals. Keep the region lower half and center calm, dark and low-detail so text placed there stays legible. Aspect 4:5. Fine grain, no watermark-like marks, no borders.
```
- **Generation Configuration:**
```json
{
  "responseModalities": ["IMAGE"],
  "imageConfig": {
    "aspectRatio": "4:5",
    "imageSize": "2K"
  }
}
```

### 2.2 Authentic Live Gemini Receipt
- **Google API Response ID:** `MvynasHKE_7L_uMPtvi9wA0`
- **Model:** `gemini-3-pro-image`
- **MIME Type:** `image/jpeg`
- **Generated Raw Bytes:** 2,554,423 bytes (~2.55 MB)
- **Raw SHA-256:** `15ed0d5d4978cc2158bb42733c4cc89ec6ef69f687ec109cde2f1172cf40ab16`
- **SynthID Watermark:** `true`
- **Cost (USD):** $0.134
- **Attempts to Success:** 1 (Succeeded on first attempt)

---

### 2.3 Claude Fable 5.1 Vision Check API Execution
- **Endpoint:** `POST https://api.anthropic.com/v1/messages`
- **Model:** `claude-fable-5-1`
- **Prompt:** `"Does this image contain any letters, digits, logos, flags, emblems, faces or people? answer JSON {containsForbidden:boolean, what:string}"`
- **Live Response Received:**
```json
{
  "passed": true,
  "containsForbidden": false,
  "what": "Abstract geometric mountain landscape with layered navy and white peaks, mist/clouds, a gold horizon line, and gradient sky; no letters, digits, logos, flags, emblems, faces, or people present."
}
```

---

## 3. Live Probe Execution & Saved Artifacts

- **Probe Image File:** `output/proofs/2026-09-14-design-studio-v2/T07_ART/probe.png`
- **Metadata File:** `output/proofs/2026-09-14-design-studio-v2/T07_ART/probe_meta.json`
- **Resolution:** 1080 × 1350 px (4:5 portrait)
- **Rasterized PNG Size:** 1,852,115 bytes (~1.85 MB)
- **PNG SHA-256:** `5a9a720f02dd5395dac3d35a530b186980f95cd8e5c7b113fc8ab7cebd2ff731`

---

## 4. Dominant Color $\Delta E_{2000}$ Verification Table

The 5 most frequent dominant color clusters extracted from the generated probe image were evaluated against the official KAAE brand palette (`#0A1628`, `#1E3A5F`, `#4770A3`, `#D4E2F0`, `#F7B500`, `#FDF8F3`, `#FFFFFF`):

| Rank | Hex Code | RGB | Frequency | Chroma ($C^*$) | Neutral ($C^* < 8$) | Nearest Palette Color | Min $\Delta E_{2000}$ | Status |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | `#141A2D` | [20, 26, 45] | 5.31% | 14.16 | No | `#0A1628` (Midnight Navy) | 3.01 | **PASSED** ($\le 25$) |
| 2 | `#232A3D` | [35, 42, 61] | 3.96% | 13.36 | No | `#0A1628` (Midnight Navy) | 6.61 | **PASSED** ($\le 25$) |
| 3 | `#323C4C` | [50, 60, 76] | 2.75% | 11.10 | No | `#1E3A5F` (Royal Navy) | 7.62 | **PASSED** ($\le 25$) |
| 4 | `#D4DCE2` | [212, 220, 226] | 1.61% | 4.17 | Yes ($4.17 < 8$) | `#D4E2F0` (Sky Ice Blue) | 3.75 | **PASSED** ($\le 25$ & Neutral) |
| 5 | `#ACC6D3` | [172, 198, 211] | 1.52% | 11.17 | No | `#D4E2F0` (Sky Ice Blue) | 8.54 | **PASSED** ($\le 25$) |

**Dominant Color Verification Verdict:** **PASSED** (100% of top clusters satisfy $\Delta E_{2000} \le 8.54 \ll 25.0$).

---

## 5. Automated Unit Tests

Suite: `packages/creative/test/studio-art-provider.test.ts` (12 tests):
- Hex ↔ RGB ↔ Lab round-trip fidelity under D65
- CIEDE2000 calculation validated against published benchmark dataset in Sharma et al. (2005):
  - Identical colors $\Delta E_{2000} = 0.000$
  - Sharma Pair 1: expected $2.0425 \pm 0.001$, computed $2.0425$ (PASS)
  - Sharma Pair 2: expected $2.7998 \pm 0.001$, computed $2.7998$ (PASS)
- Neutral tolerance rule ($C^* < 8$ passes regardless of hue distance)
- Adversarial out-of-palette chromatic failure (Magenta $\Delta E_{2000} > 25$ fails)
- Section 5.4 / P7 prompt assembly
- Aspect ratio mapping
- Claude Fable 5.1 vision check parsing & forbidden content detection
- Gemini generation attempt 1 success with synthetic receipt and receipts verification
- Retry ladder: Attempt 1 vision failure $\to$ Attempt 2 success
- Degradation ladder: Attempt 1 + 2 failure $\to$ Procedural motif fallback with `artFallback: 'procedural'`
