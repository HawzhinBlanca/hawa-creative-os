# Pipeline Deviations & Honest Technical Limits

## 1. Metric Threshold Calibration on Small Exemplar Set
The deterministic design metric thresholds in P01 (overlap rate = 0.000, margin >= 0.05, balance >= 0.850, alignment >= 0.900, type scale >= 0.900, contrast >= 4.5:1) were calibrated directly against the six owner-confirmed positive exemplars (`kaae-exemplars.json`, confirmed 2026-09-17).
Six is a small calibration set. Consequently, these thresholds must be treated as provisional. They should be recalibrated as the owner introduces further verified institutional references through P11.

## 2. Model Self-Preference Bias in Astra Judging
In P07, Astra serves as both generator and pairwise dimension-wise judge. While dimension-wise independent scoring and position-bias order-swapping (AB and BA presentation) reduce self-preference bias by 31.5% on average (up to 69.9% prompt-only per arXiv:2604.22891), prompt-only interventions cannot eliminate generator self-preference entirely. A cross-family judge (e.g. evaluating Astra against Claude or a second independent foundation family) remains structurally preferable once additional provider credits and API lanes are provisioned.

## 3. Aesthetic Predictor Generalization
Aesthetic predictors and subjective perceptual scoring generalise poorly across specialized institutional domains (especially bilingual Latin-Kurdish typography). In this pipeline, aesthetic scores are never used as a hard gate; hard gates remain strictly deterministic (geometric overlap, safe margins, WCAG contrast, character-verbatim copy integrity).

## 4. Applicability of JSON-Format Degradation Warnings
The JSON-format degradation warning reported in arXiv:2607.26922 was empirically observed on sub-10B local open-weights models. Production testing with OpenAI `gpt-6-astra` structured outputs (`response_format: { type: 'json_schema', json_schema: { strict: true } }`) demonstrated zero schema deviation or quality degradation under strict JSON schema enforcement.

## 5. Scope Invariants Maintained
- No flat concept boards as throwaway stages.
- Zero AI-generated text inside images (all copy rendered via native vector font rasterization).
- Client scope and brief copy remain strictly immutable once pipeline retrieval begins.
- Flag `DESIGN_PIPELINE_V3=off` maintained pending office lead enablement.
