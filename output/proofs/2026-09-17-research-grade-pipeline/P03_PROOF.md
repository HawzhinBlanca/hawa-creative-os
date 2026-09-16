# P03 — Layout-First Candidate Generation Proof

**Date:** 2026-09-17  
**Model:** `gpt-6-astra` (OpenAI Structured Outputs with strict JSON schema, no `$defs`)  
**Specification:** PosterLLaVa (arXiv:2406.02884), PosterMELD (arXiv:2608.02218), F12 Typography Policy  

---

## 1. Execution Summary

- **Single Brief:** "Advancing Academic Rigor & Institutional Quality: KAAE sets mandatory accreditation benchmarks and institutional quality standards under Law No. 6 of 2022 for universities across the Kurdistan Region."
- **Dispatches:** 3 identical brief requests yielding **9 distinct layouts** (3 candidates per call).
- **Schema Compliance:** 9 / 9 layouts (100%) valid `StudioLayoutV2` JSON via strict server-side scaling.
- **Anti-Twin-Card Compliance:** 0 twin-card blocks detected across all 9 layouts.
- **F12 Typography Compliance:** 100% adherence (all body/footer roles use `Verdana`; display roles use `Cinzel` / `Lora`).
- **Pairwise Distinctness:** Minimum geometric distance across all 36 pairs is **17.29px** (hard gate requires > 15px; no structural duplicates).

---

## 2. API Receipts & Cost Accounting

| Round | Response ID | Request ID | Input Tok | Output Tok | Cached Tok | Latency | Cost (USD) |
| :---: | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **1** | `chatcmpl-EOt5TiDppLlpBN1mUNdBTLjH2RNqr` | `req_d31afb8637804603901f6f29365fd5a5` | 2847 | 3122 | 2844 | 54200ms | $0.15897 |
| **2** | `chatcmpl-EOt6KyMs1omAWQmeDkmDrM0mz1w3O` | `req_159a8422d38c4db08dac5c684a7f3ea8` | 2847 | 3292 | 2844 | 55655ms | $0.16747 |
| **3** | `chatcmpl-EOt7Dt2NAmPGRfrySTKyUPLKAeyTq` | `req_ced03accda5d43328c0e529c3ac9d25f` | 2847 | 3320 | 2844 | 57678ms | $0.16887 |
| **Total** | - | - | **8541** | **9734** | **8532** | - | **$0.49532** |

*Prompt Caching:* Round 2 and 3 leveraged OpenAI prompt prefix caching (2844 cached tokens on Round 2, 2844 cached tokens on Round 3), reducing generation cost.

---

## 3. Generated Layout Candidates (9/9 Valid)

| Layout | Archetype | Shapes | Text Elements | Art Layer | Calm Region | Type Scale | Composite Score |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **layout_01.json** | `monolith_centered` | 3 | 4 | No | None | 14px / 1.25 | **0.955** |
| **layout_02.json** | `asymmetric_editorial` | 4 | 4 | No | None | 14px / 1.25 | **0.840** |
| **layout_03.json** | `hero_statement_grid` | 4 | 4 | No | None | 16px / 1.25 | **0.903** |
| **layout_04.json** | `monolith_centered` | 3 | 4 | No | None | 14px / 1.25 | **0.956** |
| **layout_05.json** | `asymmetric_editorial` | 3 | 4 | No | None | 14px / 1.25 | **0.834** |
| **layout_06.json** | `hero_statement_grid` | 4 | 4 | No | None | 14px / 1.25 | **0.906** |
| **layout_07.json** | `monolith_centered` | 3 | 4 | No | None | 14px / 1.25 | **0.965** |
| **layout_08.json** | `asymmetric_editorial` | 3 | 4 | No | None | 16px / 1.25 | **0.944** |
| **layout_09.json** | `hero_statement_grid` | 4 | 4 | No | None | 18px / 1.5 | **0.844** |

---

## 4. Verification Gate Criteria

1. **Schema Compliance:** `studioLayoutV2Schema.safeParse` passed on all 9 layouts without errors.
2. **Strict Mode Schema:** Validated that the JSON schema passed to OpenAI contains zero `$defs` and zero `$ref`, inlining all properties with `additionalProperties: false`.
3. **Capacity-Aware Sizing (PosterMELD):** Copy blocks pre-computed character capacity requirements; 0 slot overflows detected.
4. **F12 Typography Policy:** Body text strictly uses `Verdana`; titles use `Cinzel` and `Lora`. Zero unadmitted fonts.
5. **No Twin-Card Blocks:** No candidate generated side-by-side bilateral symmetric cards.
6. **Diversity Invariant:** Minimum pairwise geometric distance is 17.29px (> 15px threshold).
