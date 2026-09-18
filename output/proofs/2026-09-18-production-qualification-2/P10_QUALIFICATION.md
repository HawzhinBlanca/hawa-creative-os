# P10 Full Qualification Report: 20 Held-Out Briefs (Multi-Stage Live Run)

**Briefs:** 20 · **completed:** 20 · **failed:** 0

**Measured at:** `910a6a6`, production tier; resumed at `4822e01` for brief_09_en_story916, brief_10_en_story916, brief_11_ckb_story916, brief_12_ckb_story916, brief_13_en_a4doc, brief_14_en_a4doc, brief_15_ckb_a4doc, brief_16_ckb_a4doc, brief_17_en_landscape169, brief_18_en_landscape169, brief_19_ckb_landscape169, brief_20_ckb_landscape169

Verdict: **PASS** — all 20 briefs completed and every gate met.

> Rates below are computed over the 20 completed briefs. A partial run is reported as partial and does NOT constitute a qualification pass.

## 1. Headline Results & Comparative Benchmarks

| Metric | Target / Published Benchmark | Pipeline Result (Multi-Stage Live Run) | Status |
| :--- | :--- | :--- | :--- |
| **Total Model Calls Recorded** | at least 6 calls x 20 completed briefs = 120 | **122 calls** | **PASS** |
| **Print-Ready Rate (PRR)** | 81.3% (PosterMELD, arXiv:2608.02218) | **95.0%** (19/20) | **PASS** |
| **Median Cost per Brief** | USD 0.380 (Published Comparison) | **$0.358160** | **PASS** |
| **Canary Win Rate (Real Judge)** | >= 95.0% of completed briefs | **100.0%** (20/20) | **PASS** |
| **Order-Swap Consistency** | >= 80.0% | **90.0%** (18/20) | **PASS** |
| **Mean Composite Score** | Measured Mean Score | **0.961** | **PASS** |
| **Copy & Readability (exact copy, textLegibility, typeScale)** | >= 90.0% of completed briefs | **100.0%** (20/20) | **PASS** |
| **Hard-QA Escapes** | Exactly 0 | **0** | **PASS** |
| **Production Hard-QA Pass Rate** | 100% of completed briefs | **100.0%** (20/20) | **PASS** |
| **Winners Chosen by the Judge** | Reported | 18/20; the rest by composite after a tie, an unreliable judge or a single candidate | — |
| **Distinct Skeletons** | No published threshold | **2 distinct archetypes** over 20 briefs (monolith_centered=17, hero_statement_grid=3) | **MEASURED** |
| **Editability Rate** | 100.0% Verified Mutation Test | **100.0%** (20/20) | **PASS** |
| **Font Fidelity (measured at render)** | Every specified family renders exactly | **every family used renders exactly on this host** | **PASS** |

> The **Distinct Skeletons** row has no numeric target in the published literature, so it is reported as measured rather than scored. The per-brief `distinct_skeleton` column in the CSV compares a brief only against the one dispatched immediately before it and is order-dependent under parallel batches; the archetype set size above is the diversity figure to read.
> **Hard-QA escapes** are briefs this report marks print-ready that production's own hard QA (the studio's QA stage, shared code) rejects. The design measured is the pipeline's winner, produced by the same shared functions production's studio calls.
> This run exercises the layout, critique and judge stages. No image-generation call is made, so the cost figures above are text-model costs only and do not include the art lane.
> **Font fidelity** is measured by rasterising a probe in each family and in a family that cannot exist: identical output means the renderer substituted a fallback face. `fc-match` is not a valid check, because it resolves a family name that the rasteriser then fails to use. When this row fails, the preview images are not evidence about the typography of the design.

---

## 2. Multi-Row Live Model Call Ledger (`LEDGER.csv`)
Total calls recorded: **122**

```csv
call_id,x_request_id,stage,brief_id,model,input_tokens,cached_tokens,output_tokens,gross_cost_usd,cache_discount_usd,net_cost_usd,latency_ms,timestamp
chatcmpl-EPSWOayQWiNzJVBEW1yIUbOds902p,req_48f6882a91a543d091825ccd8fe1881d,P03_LAYOUT,brief_01_en_square,gpt-6-astra,3987,0,3643,0.222020,0.000000,0.222020,54886,2026-09-18T13:03:17.795Z
chatcmpl-EPSXHtu2ALLe0ih0yRJGJBgAvxoBY,req_dc9a435b50f34481977d91a8291923a4,P05_CRITIQUE,brief_01_en_square,gpt-6-astra,1427,0,146,0.021570,0.000000,0.021570,6602,2026-09-18T13:03:24.598Z
chatcmpl-EPSXS5i1IcTW5kRN1YrZAmez399Be,req_647e4c4d7d82457abc10b10d3361b4f9,P07_JUDGE_AB,brief_01_en_square,gpt-6-astra,1286,0,453,0.035510,0.000000,0.035510,14879,2026-09-18T13:03:40.050Z
chatcmpl-EPSXdcIfAssHd3LYT6PShjZh8iYi8,req_2b37cc4060454ef3bdffa794e85a98e8,P07_JUDGE_BA,brief_01_en_square,gpt-6-astra,1286,0,463,0.036010,0.000000,0.036010,11952,2026-09-18T13:03:52.010Z
chatcmpl-EPSXpGmAiBiMIj8dlMIzNiymXpMRo,req_b73d5259e7be42f481a098f8b9bca956,P07_CANARY_AB,brief_01_en_square,gpt-6-astra,1286,0,464,0.036060,0.000000,0.036060,9843,2026-09-18T13:04:02.435Z
chatcmpl-EPSXzO79ciXlsp99MVNIDDShFPKsP,req_b768e9f6422b4ababae7f146738fc422,P07_CANARY_BA,brief_01_en_square,gpt-6-astra,1286,0,446,0.035160,0.000000,0.035160,10190,2026-09-18T13:04:12.633Z
chatcmpl-EPSWPVedgOY5J6zDAirlRiGXutVVf,req_42c34b47edcf4a4e80bd3fa91515f682,P03_LAYOUT,brief_02_en_square,gpt-6-astra,3950,2500,3513,0.215150,0.022500,0.192650,52535,2026-09-18T13:03:15.456Z
chatcmpl-EPSXGOgHRzhbIPkd0dd6elAyu8mTU,req_817248d0654a4155abd172f324bd4d4b,P05_CRITIQUE,brief_02_en_square,gpt-6-astra,1427,0,135,0.021020,0.000000,0.021020,6957,2026-09-18T13:03:22.739Z
chatcmpl-EPSXMDKWe5nNTylcM4QNjhunwRRf9,req_32085391c55b4b6daef3127f0bc90588,P07_JUDGE_AB,brief_02_en_square,gpt-6-astra,1286,0,433,0.034510,0.000000,0.034510,9995,2026-09-18T13:03:33.285Z
chatcmpl-EPSXW65M2JpRq29pavolJnKajTRoa,req_c6024faf1ed943e8be5a6dbd02719e5f,P07_JUDGE_BA,brief_02_en_square,gpt-6-astra,1286,0,466,0.036160,0.000000,0.036160,11861,2026-09-18T13:03:45.150Z
chatcmpl-EPSXiqZbN9280Vd2SnwDzgL59ai4r,req_da7b1b171624403e877c28faf331819e,P07_CANARY_AB,brief_02_en_square,gpt-6-astra,1286,0,471,0.036410,0.000000,0.036410,10009,2026-09-18T13:03:55.722Z
chatcmpl-EPSXsAzKhwfB4S42leSiZw1jCOL31,req_00d3b60d14a041f7b6de2b22a708f98b,P07_CANARY_BA,brief_02_en_square,gpt-6-astra,1286,0,492,0.037460,0.000000,0.037460,10390,2026-09-18T13:04:06.116Z
chatcmpl-EPSY9qet7uAKcZA1R3y6olg0eXlpE,req_180c009f750847218d321bd9fe653dac,P03_LAYOUT,brief_03_ckb_square,gpt-6-astra,4160,2500,3344,0.208800,0.022500,0.186300,48921,2026-09-18T13:05:02.120Z
chatcmpl-EPSYxRzTjkKu91Tk3CoqzYu5K4UAZ,req_e01b3ccba995489796b7b0b7a9e97a3f,P05_CRITIQUE,brief_03_ckb_square,gpt-6-astra,1427,0,142,0.021370,0.000000,0.021370,6023,2026-09-18T13:05:08.446Z
chatcmpl-EPSZ3HOWczlBK3oyqEePlwiaLnKom,req_f9a73879b3c248d7a6522b2b5f700409,P07_JUDGE_AB,brief_03_ckb_square,gpt-6-astra,1286,0,496,0.037660,0.000000,0.037660,12776,2026-09-18T13:05:21.795Z
chatcmpl-EPSZIebCTYRzD5set6A4AsTrBaFWN,req_011ce9fb75ba4b889b471b3562bfe385,P07_JUDGE_BA,brief_03_ckb_square,gpt-6-astra,1286,0,421,0.033910,0.000000,0.033910,13034,2026-09-18T13:05:34.836Z
chatcmpl-EPSZUaNWOq61jmZxCi0sPubMc5NrQ,req_5a9818e1ea1c46079f5e07a8182f28c3,P07_CANARY_AB,brief_03_ckb_square,gpt-6-astra,1286,0,463,0.036010,0.000000,0.036010,10738,2026-09-18T13:05:46.160Z
chatcmpl-EPSZh1qq3LfDlb5xBn3tS0E9tIwwY,req_187b069683c8432381f723b23c40fe27,P07_CANARY_BA,brief_03_ckb_square,gpt-6-astra,1286,0,451,0.035410,0.000000,0.035410,11916,2026-09-18T13:05:58.082Z
chatcmpl-EPSYAcL6Op9z3cMUQMvl6mySpTiqf,req_4e12d4f645e849bf990c2982a8e807f6,P03_LAYOUT,brief_04_ckb_square,gpt-6-astra,4172,2500,3744,0.228920,0.022500,0.206420,55822,2026-09-18T13:05:09.023Z
chatcmpl-EPSZ4aDQb5Av3C6JobLuQ3mTSnlHD,req_880c5d8b722c494eacb21878b9d3676b,P05_CRITIQUE,brief_04_ckb_square,gpt-6-astra,1427,0,86,0.018570,0.000000,0.018570,3519,2026-09-18T13:05:12.774Z
chatcmpl-EPSZ8SHuLPAZGgucZp9R3uAFWCRxU,req_be70ef68edfc4db7afeaa7c624e6cd1f,P07_JUDGE_AB,brief_04_ckb_square,gpt-6-astra,1286,0,439,0.034810,0.000000,0.034810,9384,2026-09-18T13:05:22.694Z
chatcmpl-EPSZKYzzbu94EppoaZjneqtNVBq7k,req_4a551f7f42214d8184af9c3411783698,P07_JUDGE_BA,brief_04_ckb_square,gpt-6-astra,1286,0,426,0.034160,0.000000,0.034160,12790,2026-09-18T13:05:35.488Z
chatcmpl-EPSZWnWWIOmU3fWS7lWDCwvRg2PIF,req_af7bfd9ca1b749329a60801b0c60fe92,P07_CANARY_AB,brief_04_ckb_square,gpt-6-astra,1286,0,485,0.037110,0.000000,0.037110,13264,2026-09-18T13:05:49.308Z
chatcmpl-EPSZiIk22FXg9tJiF3xxAZqn1RjmB,req_60761bd079e5489a9ef444f598c080f8,P07_CANARY_BA,brief_04_ckb_square,gpt-6-astra,1286,0,462,0.035960,0.000000,0.035960,13120,2026-09-18T13:06:02.436Z
chatcmpl-EPSZxvo2tX3ZTNlBKw0IL4BMCHNpF,req_91ee17d6744e4bf9959d1d3adf17c6b0,P03_LAYOUT,brief_05_en_portrait45,gpt-6-astra,4003,2500,3402,0.210130,0.022500,0.187630,51643,2026-09-18T13:06:54.671Z
chatcmpl-EPSalbnytZSzA768pFtC63aIZt4iu,req_700cf540b44241878546efc6e502486e,P05_CRITIQUE,brief_05_en_portrait45,gpt-6-astra,1371,0,286,0.028010,0.000000,0.028010,8681,2026-09-18T13:07:03.579Z
chatcmpl-EPSavcjBwfDwLoTrrWqCO9DIf4UNt,req_15de75fe96af4d1fbc289bccdf1f35a5,P07_JUDGE_AB,brief_05_en_portrait45,gpt-6-astra,1170,0,475,0.035450,0.000000,0.035450,12644,2026-09-18T13:07:16.814Z
chatcmpl-EPSb8jpV1HF9WW7UcL3QN8JnN06vw,req_d68fd623b3ad43b5aa5fd24e9597a301,P07_JUDGE_BA,brief_05_en_portrait45,gpt-6-astra,1170,0,453,0.034350,0.000000,0.034350,12172,2026-09-18T13:07:28.993Z
chatcmpl-EPSbKteOWDHN9zvklekuwDKrtLpJ8,req_25cc85cb71674e2cad8dcda964c23412,P07_CANARY_AB,brief_05_en_portrait45,gpt-6-astra,1170,0,475,0.035450,0.000000,0.035450,10310,2026-09-18T13:07:39.872Z
chatcmpl-EPSbUEgWPDVVZntB9R9C7VpJMdwRV,req_14dfbecb341f4d37b5f2b423f3796608,P07_CANARY_BA,brief_05_en_portrait45,gpt-6-astra,1170,0,510,0.037200,0.000000,0.037200,10888,2026-09-18T13:07:50.765Z
chatcmpl-EPSZvJPBFSokgOPlwdE5oUp4DJxpd,req_26b8401e141544028bd0b5a77570539f,P03_LAYOUT,brief_06_en_portrait45,gpt-6-astra,4001,2500,3720,0.226010,0.022500,0.203510,53112,2026-09-18T13:06:56.141Z
chatcmpl-EPSaninfXNwTUiQM0h0czCGwsqk3I,req_332e3a1b104d4580b73c23acb5c8a116,P05_CRITIQUE,brief_06_en_portrait45,gpt-6-astra,1406,0,299,0.029010,0.000000,0.029010,8602,2026-09-18T13:07:04.944Z
chatcmpl-EPSawxW2UyXRTF3ZsNAD5QpB2E2ix,req_40ff981212284857a571212b79d3cc7d,P07_JUDGE_AB,brief_06_en_portrait45,gpt-6-astra,1170,0,445,0.033950,0.000000,0.033950,10813,2026-09-18T13:07:16.331Z
chatcmpl-EPSb7U5xBSdqLLwBNdy6i6gES9mVE,req_f8ba27f716be4818ac73e1ed814b034e,P07_JUDGE_BA,brief_06_en_portrait45,gpt-6-astra,1170,0,443,0.033850,0.000000,0.033850,12077,2026-09-18T13:07:28.415Z
chatcmpl-EPSbKUlrSaj7x8nxSZE30Qu4rPyW2,req_5cb7880482fd4add85e9c1f6caf1726e,P07_CANARY_AB,brief_06_en_portrait45,gpt-6-astra,1176,0,488,0.036160,0.000000,0.036160,11808,2026-09-18T13:07:40.797Z
chatcmpl-EPSbVv6K01T3JDcXSmxlGUUUQiSAN,req_d306e00c95f6468f83cf422e9b4eeafe,P07_CANARY_BA,brief_06_en_portrait45,gpt-6-astra,1176,0,476,0.035560,0.000000,0.035560,10977,2026-09-18T13:07:51.779Z
chatcmpl-EPSbgP6M1uFKzHUO5GFI9yzlmAdJw,req_58a4fb767e81450fa42ab097a8c5293f,P03_LAYOUT,brief_07_ckb_portrait45,gpt-6-astra,4256,2500,3722,0.228660,0.022500,0.206160,53650,2026-09-18T13:08:46.012Z
chatcmpl-EPScZjiQtWPuc0k7pOYwXITE0lXy2,req_221841ee15a04e3cbce887910921014d,P05_CRITIQUE,brief_07_ckb_portrait45,gpt-6-astra,1340,0,419,0.034350,0.000000,0.034350,10572,2026-09-18T13:08:56.872Z
chatcmpl-EPSckNbQLXiAZdE1YfDpuDqGnSTCQ,req_3f945e3382fc48199a17904c4b09e21e,P06_REFINE_CRITIQUE,brief_07_ckb_portrait45,gpt-6-astra,1340,1152,421,0.034450,0.010368,0.024082,10234,2026-09-18T13:09:07.311Z
chatcmpl-EPSctJUxCN81vdyp9J9iEYsj6wrD4,req_f4987a7352294dbd9a9046382fe39be8,P06_REFINE,brief_07_ckb_portrait45,gpt-6-astra,1839,0,1014,0.069090,0.000000,0.069090,14050,2026-09-18T13:09:21.407Z
chatcmpl-EPSd8YjHaBKCHFgLqRsZFcxKnF6Px,req_47cb469a666d46fdbc1104b4b1e5cbef,P07_JUDGE_AB,brief_07_ckb_portrait45,gpt-6-astra,1178,0,460,0.034780,0.000000,0.034780,10580,2026-09-18T13:09:32.692Z
chatcmpl-EPSdJmhT5XNNSJTe7E1xI5zd5zDbR,req_cc0b43662f98447481dc0b29b1a03659,P07_JUDGE_BA,brief_07_ckb_portrait45,gpt-6-astra,1178,0,446,0.034080,0.000000,0.034080,10774,2026-09-18T13:09:43.472Z
chatcmpl-EPSdVbdE2DBb0UNbfLSVUd8fUBcYG,req_f3ad24ae82734e1581cf2ca1c029602d,P07_CANARY_AB,brief_07_ckb_portrait45,gpt-6-astra,1176,0,466,0.035060,0.000000,0.035060,12098,2026-09-18T13:09:56.218Z
chatcmpl-EPSdhr0g8zMfkptxzkPdi0YrXggVG,req_3252ad77050d4ba2b99dd20f06b10dec,P07_CANARY_BA,brief_07_ckb_portrait45,gpt-6-astra,1176,0,469,0.035210,0.000000,0.035210,10862,2026-09-18T13:10:07.086Z
chatcmpl-EPSbg5EwQNF9PAD3HxbuGE9KdijCu,req_9c46ae3dcc60493c94d554350d66c943,P03_LAYOUT,brief_08_ckb_portrait45,gpt-6-astra,4215,2500,3410,0.212650,0.022500,0.190150,47863,2026-09-18T13:08:40.227Z
chatcmpl-EPScUR9WTHal9c81Yfr710wHCvpeD,req_0e67be690d914dab81503c0f6af4ccf1,P05_CRITIQUE,brief_08_ckb_portrait45,gpt-6-astra,1371,0,274,0.027410,0.000000,0.027410,8456,2026-09-18T13:08:48.946Z
chatcmpl-EPSccKMxdD6GgnkUFV77PoRnDle0W,req_df2091d3804a467f812555af6aed35dc,P07_JUDGE_AB,brief_08_ckb_portrait45,gpt-6-astra,1175,0,435,0.033500,0.000000,0.033500,10308,2026-09-18T13:08:59.831Z
chatcmpl-EPScm44QBUfCEG0FjiwGMY1iKGBkB,req_b2256ccd730d4574933ad809ef19944c,P07_JUDGE_BA,brief_08_ckb_portrait45,gpt-6-astra,1175,0,432,0.033350,0.000000,0.033350,10201,2026-09-18T13:09:10.041Z
chatcmpl-EPScxTgvOCyO2RfCXIj3euTL4dBxX,req_a3515b3cb9794d81b45c83b186be475c,P07_CANARY_AB,brief_08_ckb_portrait45,gpt-6-astra,1170,0,492,0.036300,0.000000,0.036300,10473,2026-09-18T13:09:21.129Z
chatcmpl-EPSd71CeWWfGQu79OSDAu2Zfa0ZSf,req_b374080acc4747e79881830c91b71fb8,P07_CANARY_BA,brief_08_ckb_portrait45,gpt-6-astra,1170,0,481,0.035750,0.000000,0.035750,10894,2026-09-18T13:09:32.027Z
chatcmpl-EPTGTaIzJPV932xo8uVPWRjpxb1i3,req_e3509e26f8fb457da6661ccb6f59a7f3,P03_LAYOUT,brief_09_en_story916,gpt-6-astra,3978,3975,3463,0.212930,0.035775,0.177155,120562,2026-09-18T13:50:49.787Z
chatcmpl-EPTHHde6nW9EFlZ5VHGT4KFltoKfK,req_e08f9f854e2c4fa7a31a1daf3bb804b1,P05_CRITIQUE,brief_09_en_story916,gpt-6-astra,1297,0,191,0.022520,0.000000,0.022520,6251,2026-09-18T13:50:56.253Z
chatcmpl-EPTHNDh4eXa9MNsM66O0fAO5DEVpC,req_518600875c85460484a03aafc5f7bb57,P07_JUDGE_AB,brief_09_en_story916,gpt-6-astra,1016,0,452,0.032760,0.000000,0.032760,10877,2026-09-18T13:51:07.743Z
chatcmpl-EPTHZTQkd15B3iwltiwYtF9Uwhuyj,req_907d8c709f9d40e5bb6145e380c185de,P07_JUDGE_BA,brief_09_en_story916,gpt-6-astra,1016,0,534,0.036860,0.000000,0.036860,13142,2026-09-18T13:51:20.890Z
chatcmpl-EPTHmhLYwQyUKCluFlnUTVdYIRXvr,req_14705be2547f4615964d5893100c8dae,P07_CANARY_AB,brief_09_en_story916,gpt-6-astra,1016,0,457,0.033010,0.000000,0.033010,10975,2026-09-18T13:51:32.502Z
chatcmpl-EPTHxFn7AxhT5beZxWNgbCY4FobBI,req_5f5aabf7430d464dab3d4f4ef3e8432a,P07_CANARY_BA,brief_09_en_story916,gpt-6-astra,1016,0,463,0.033310,0.000000,0.033310,12840,2026-09-18T13:51:45.347Z
chatcmpl-EPTGTpML9Rkxca52dyVfKVFgjTGyw,req_36c4d4bfee4648b6a382c3dc0a845548,P03_LAYOUT,brief_10_en_story916,gpt-6-astra,3961,3958,3493,0.214260,0.035622,0.178638,119411,2026-09-18T13:50:48.647Z
chatcmpl-EPTHGb8pIVdVxEu2FjFM6e5XqDLwx,req_cf2d8b9021c64e77bd7dd8687925cb10,P05_CRITIQUE,brief_10_en_story916,gpt-6-astra,1297,0,131,0.019520,0.000000,0.019520,6272,2026-09-18T13:50:55.312Z
chatcmpl-EPTHMH9qijNimNaocCHATFi56Ueqh,req_59a44c6302524b8fa067ce16ec46efc2,P07_JUDGE_AB,brief_10_en_story916,gpt-6-astra,1016,0,560,0.038160,0.000000,0.038160,15370,2026-09-18T13:51:11.315Z
chatcmpl-EPTHcOR29v2szFrMZn6diREwazczg,req_50b1883c41d54bb38e2c7ece15fc7021,P07_JUDGE_BA,brief_10_en_story916,gpt-6-astra,1016,0,514,0.035860,0.000000,0.035860,14436,2026-09-18T13:51:25.755Z
chatcmpl-EPTHrTeX7e60uNSAIR8x7cyLWHwsi,req_5da836b765814be6981692efcd4302ea,P07_CANARY_AB,brief_10_en_story916,gpt-6-astra,1022,0,465,0.033470,0.000000,0.033470,11360,2026-09-18T13:51:37.729Z
chatcmpl-EPTI20Bqot2kF5qQF3byZ3IX3Txv9,req_b8e726c7a12846a1a6650cf0008030b1,P07_CANARY_BA,brief_10_en_story916,gpt-6-astra,1022,0,451,0.032770,0.000000,0.032770,10619,2026-09-18T13:51:48.354Z
chatcmpl-EPTIDz679LtBnTriN8IboedVTID6O,req_91e47b7b7a5d4ace911529bc8a55f38b,P03_LAYOUT,brief_11_ckb_story916,gpt-6-astra,4189,2500,3403,0.212040,0.022500,0.189540,48502,2026-09-18T13:52:37.493Z
chatcmpl-EPTJ05ezt1jOPSgGQY5nSqgbJDLXI,req_114004edb7a2451dacb819fe0f011545,P05_CRITIQUE,brief_11_ckb_story916,gpt-6-astra,1296,0,293,0.027610,0.000000,0.027610,8556,2026-09-18T13:52:46.366Z
chatcmpl-EPTJA6OzMLbU5ILDCTJiKD114rQvi,req_6286416bd7bb436db57a1e5fd33b438b,P07_JUDGE_AB,brief_11_ckb_story916,gpt-6-astra,1016,0,513,0.035810,0.000000,0.035810,13152,2026-09-18T13:53:00.167Z
chatcmpl-EPTJNCgLQDJwDtTHHV32CvB1fPOiw,req_4027b4e2f33547b6b3480174edda3605,P07_JUDGE_BA,brief_11_ckb_story916,gpt-6-astra,1016,0,483,0.034310,0.000000,0.034310,12170,2026-09-18T13:53:12.341Z
chatcmpl-EPTJacrrMVb5LiND8mNq2Q5WtSSOx,req_74be7a91884c48a99f5437a66174ac67,P07_CANARY_AB,brief_11_ckb_story916,gpt-6-astra,1016,0,474,0.033860,0.000000,0.033860,11940,2026-09-18T13:53:24.972Z
chatcmpl-EPTJl31lQIhlICE451DHJBx4cN22n,req_7f0832809fa546c7b6858dfdbeb9690c,P07_CANARY_BA,brief_11_ckb_story916,gpt-6-astra,1016,0,522,0.036260,0.000000,0.036260,12219,2026-09-18T13:53:37.195Z
chatcmpl-EPTIDeZjQCsBxE3a2Uh8sj9J1ue26,req_1c3c42db91ec477a9923bc9efe9073a8,P03_LAYOUT,brief_12_ckb_story916,gpt-6-astra,4153,2500,3478,0.215430,0.022500,0.192930,47079,2026-09-18T13:52:36.070Z
chatcmpl-EPTIzsO80IeJYB3epmexgDKbUTA5R,req_dfc4948b836c410ba5581693b85b38dc,P05_CRITIQUE,brief_12_ckb_story916,gpt-6-astra,1296,0,167,0.021310,0.000000,0.021310,7073,2026-09-18T13:52:43.478Z
chatcmpl-EPTJ8Yei4q60o80EdvxxRoIgRKKkU,req_28e7a4b2b0564d079759f154f856109d,P07_JUDGE_AB,brief_12_ckb_story916,gpt-6-astra,1016,0,414,0.030860,0.000000,0.030860,11733,2026-09-18T13:52:55.855Z
chatcmpl-EPTJIzT30bHIA4gs11lJWX3kQJPBi,req_0885eb3214954a389160d7bc1415024c,P07_JUDGE_BA,brief_12_ckb_story916,gpt-6-astra,1016,0,432,0.031760,0.000000,0.031760,10229,2026-09-18T13:53:06.092Z
chatcmpl-EPTJTPcriGb5v1oFytS2iYDN5Yh4n,req_ea69ef93bd304f6aa15f266c6a51464e,P07_CANARY_AB,brief_12_ckb_story916,gpt-6-astra,1016,0,454,0.032860,0.000000,0.032860,10896,2026-09-18T13:53:17.636Z
chatcmpl-EPTJewWqHnGiRYeiR4jnVX7tk8G66,req_e2081daa370a4df7a2a9f717e3e10bde,P07_CANARY_BA,brief_12_ckb_story916,gpt-6-astra,1016,0,459,0.033110,0.000000,0.033110,10297,2026-09-18T13:53:27.936Z
chatcmpl-EPTJydrMWr6f8SIjVS5C3QRsVYqod,req_97cd2051b03840e28e24355179512479,P03_LAYOUT,brief_13_en_a4doc,gpt-6-astra,4038,2500,3939,0.237330,0.022500,0.214830,58579,2026-09-18T13:54:36.472Z
chatcmpl-EPTKvW9KxhJslVYIMnJuML3hQb9AU,req_38bda44a37d24cd6bf656658bf2c8f52,P05_CRITIQUE,brief_13_en_a4doc,gpt-6-astra,1391,0,283,0.028060,0.000000,0.028060,7984,2026-09-18T13:54:44.690Z
chatcmpl-EPTL3wW5PJ6DZLmTQHxRVTg7seDxb,req_6ec59ddc422e41aa98f60aa45ce49e73,P07_JUDGE_AB,brief_13_en_a4doc,gpt-6-astra,1132,0,516,0.037120,0.000000,0.037120,12378,2026-09-18T13:54:57.747Z
chatcmpl-EPTLJFWBc5LZKTu97MgcU7Is74iXB,req_1a4a69a4ab93462ba1c5d16c7f97ee97,P07_JUDGE_BA,brief_13_en_a4doc,gpt-6-astra,1132,0,478,0.035220,0.000000,0.035220,14200,2026-09-18T13:55:11.954Z
chatcmpl-EPTLXtPdZ4nzmUkZdOKzfNXv4cZJz,req_ab33bd180c7f4bbc85a3cb65f5a42ca0,P07_CANARY_AB,brief_13_en_a4doc,gpt-6-astra,1132,0,492,0.035920,0.000000,0.035920,23305,2026-09-18T13:55:35.902Z
chatcmpl-EPTLsbAPkQHPwIMdos8CSzb0zVumq,req_a7478d0ef263479b8ca96078815d9a93,P07_CANARY_BA,brief_13_en_a4doc,gpt-6-astra,1132,0,466,0.034620,0.000000,0.034620,10493,2026-09-18T13:55:46.400Z
chatcmpl-EPTL1qKdMfQwJeeSjKxl0G1swBZER,req_d91f5aae2ff44f049aa117a3e7a9497e,P03_LAYOUT,brief_14_en_a4doc,gpt-6-astra,3988,3985,3954,0.237580,0.035865,0.201715,125344,2026-09-18T13:55:43.238Z
chatcmpl-EPTM0aEGL5ojvi6W5jVRwwoeobjrZ,req_2dddf317f962411a9f10d0463b51f558,P05_CRITIQUE,brief_14_en_a4doc,gpt-6-astra,1358,0,290,0.028080,0.000000,0.028080,7053,2026-09-18T13:55:50.513Z
chatcmpl-EPTM9gJyjV69DRBoXGVY8UJCbet9v,req_bdb5c7208f7143a6a4315feecbd0c8ee,P07_JUDGE_AB,brief_14_en_a4doc,gpt-6-astra,1132,0,433,0.032970,0.000000,0.032970,12332,2026-09-18T13:56:03.488Z
chatcmpl-EPTMNNAN9C11blFjwdMBHVURS67ny,req_432b6bea9f3649f09d1fc9ca4b5bd01e,P07_JUDGE_BA,brief_14_en_a4doc,gpt-6-astra,1132,0,438,0.033220,0.000000,0.033220,14405,2026-09-18T13:56:17.897Z
chatcmpl-EPTMhOKK7BdgGT9YsBlGkQz6AcAi4,req_8e59b2f76a0942caaca438aec64790aa,P07_CANARY_AB,brief_14_en_a4doc,gpt-6-astra,1132,0,469,0.034770,0.000000,0.034770,19486,2026-09-18T13:56:38.022Z
chatcmpl-EPTMunagCLiMv38cnk0AFuVmhmR8e,req_a61bb657df584f0b9870a7235d16ef3b,P07_CANARY_BA,brief_14_en_a4doc,gpt-6-astra,1132,0,504,0.036520,0.000000,0.036520,11741,2026-09-18T13:56:49.769Z
chatcmpl-EPTN5bRKL4DrS2F6AwCuZMBcrYXKh,req_9fb0d7b8211b48e1baeb893458675c46,P03_LAYOUT,brief_15_ckb_a4doc,gpt-6-astra,4225,2500,3561,0.220300,0.022500,0.197800,53549,2026-09-18T13:57:43.997Z
chatcmpl-EPTNx36fxrSdEIJgtHlD4d833ijuh,req_c947d990dac44c1e833f6f7e45ce40c4,P05_CRITIQUE,brief_15_ckb_a4doc,gpt-6-astra,1359,0,291,0.028140,0.000000,0.028140,8072,2026-09-18T13:57:52.375Z
chatcmpl-EPTO5F1NFrqaFO6jSm0IMnLsD1W0n,req_0ce65f9a0a7c428cbc342b139a70418b,P07_JUDGE_AB,brief_15_ckb_a4doc,gpt-6-astra,1137,0,430,0.032870,0.000000,0.032870,11671,2026-09-18T13:58:04.689Z
chatcmpl-EPTOLomtvOI1ZdjbEMts1uWgsKlhQ,req_6dbe3ed383fd432fa16c9b8ef9fec9ce,P07_JUDGE_BA,brief_15_ckb_a4doc,gpt-6-astra,1137,0,390,0.030870,0.000000,0.030870,13871,2026-09-18T13:58:18.567Z
chatcmpl-EPTOWp1bfh8XXTkKg1uJPutmoypCE,req_47235fb70f164e65beec23f725631832,P07_CANARY_AB,brief_15_ckb_a4doc,gpt-6-astra,1132,0,476,0.035120,0.000000,0.035120,11571,2026-09-18T13:58:30.793Z
chatcmpl-EPTOhpw401pBzuu9ov0za1Meb8GU3,req_d7785093db6f49c3bb1f691154f755e9,P07_CANARY_BA,brief_15_ckb_a4doc,gpt-6-astra,1132,0,464,0.034520,0.000000,0.034520,12235,2026-09-18T13:58:43.032Z
chatcmpl-EPTN7TR4NqcBTnD5MDu0iN3DAWuy3,req_7c3958b4a5db4b6e9630844cd09e3d77,P03_LAYOUT,brief_16_ckb_a4doc,gpt-6-astra,4184,2500,3515,0.217590,0.022500,0.195090,52779,2026-09-18T13:57:43.227Z
chatcmpl-EPTNxKunr6wkRyCvLP8HhFrlsAuhV,req_abd6a377be15423d84c92dc39099127a,P05_CRITIQUE,brief_16_ckb_a4doc,gpt-6-astra,1389,0,142,0.020990,0.000000,0.020990,5951,2026-09-18T13:57:49.471Z
chatcmpl-EPTO2hIDmCYAAFCK6eWgxWxmQo1iO,req_47c2286edec94b1fbab4d189d4c35dbb,P07_JUDGE_AB,brief_16_ckb_a4doc,gpt-6-astra,1132,0,607,0.041670,0.000000,0.041670,17310,2026-09-18T13:58:07.457Z
chatcmpl-EPTOO5VGDsPhUgOu8rPtqwH87YmYr,req_a1c0cf5c48c04a2c95580f4992235e38,P07_JUDGE_BA,brief_16_ckb_a4doc,gpt-6-astra,1132,0,505,0.036570,0.000000,0.036570,16449,2026-09-18T13:58:23.910Z
chatcmpl-EPTObhOD41n1PPLpWfLhfRiDyj6rq,req_d390847fad1d489f8f1fe136f88ee8df,P07_CANARY_AB,brief_16_ckb_a4doc,gpt-6-astra,1132,0,461,0.034370,0.000000,0.034370,11935,2026-09-18T13:58:36.484Z
chatcmpl-EPTOnRDYK3L7k1qbi38wdd2q7iJKR,req_ecb6fbb3e45c4500aa1e9d16ceb52ddf,P07_CANARY_BA,brief_16_ckb_a4doc,gpt-6-astra,1132,0,463,0.034470,0.000000,0.034470,14133,2026-09-18T13:58:50.622Z
chatcmpl-EPTP3NPBCJaUqrmKEfRxBeeULfbDA,req_650e0ed566634953b09d16c17ff498b4,P03_LAYOUT,brief_17_en_landscape169,gpt-6-astra,4017,2500,3785,0.229420,0.022500,0.206920,60460,2026-09-18T13:59:51.732Z
chatcmpl-EPTQ32kmTRtdjIaH4GBKSFo445Aox,req_e22ffe1055c04031875e0aa8815ef8e2,P05_CRITIQUE,brief_17_en_landscape169,gpt-6-astra,1264,0,215,0.023390,0.000000,0.023390,9814,2026-09-18T14:00:01.748Z
chatcmpl-EPTQD3eYvPQN7LwcZFtdCNKj5jXJo,req_fe69e016421b4e7dbc838f67b363fda9,P07_JUDGE_AB,brief_17_en_landscape169,gpt-6-astra,1021,0,446,0.032510,0.000000,0.032510,14200,2026-09-18T14:00:16.577Z
chatcmpl-EPTQQKGUJJp5yikOpxvCkAJSYV4Yk,req_9393e85badc14ae6a7091946f38394e7,P07_JUDGE_BA,brief_17_en_landscape169,gpt-6-astra,1021,0,576,0.039010,0.000000,0.039010,18114,2026-09-18T14:00:34.699Z
chatcmpl-EPTQheR8K4DYEdSEXWBCDeH4VRmDR,req_a5dceb29609d48efb602131650a1741b,P07_CANARY_AB,brief_17_en_landscape169,gpt-6-astra,1016,0,469,0.033610,0.000000,0.033610,9999,2026-09-18T14:00:45.346Z
chatcmpl-EPTQsDdFKPqWKu06JbKzKDdrmzqyk,req_4f69385b8d504a6eab09ef32fc1ab189,P07_CANARY_BA,brief_17_en_landscape169,gpt-6-astra,1016,0,485,0.034410,0.000000,0.034410,11086,2026-09-18T14:00:56.437Z
chatcmpl-EPTP1jOnEJ2UmlzNe2JmIsRLtgCJj,req_2162cbaa638644b5b87fe97478959a64,P03_LAYOUT,brief_18_en_landscape169,gpt-6-astra,3992,2500,3802,0.230020,0.022500,0.207520,57974,2026-09-18T13:59:49.247Z
chatcmpl-EPTPy5cLd6BXVCfwcrW5LVw4ECu4H,req_763c2fe0f7e745e5b41ec34307c116e0,P05_CRITIQUE,brief_18_en_landscape169,gpt-6-astra,1264,0,133,0.019290,0.000000,0.019290,5113,2026-09-18T13:59:54.588Z
chatcmpl-EPTQOgRtzJdbqCGs6m8J6wV4oLIHx,req_6ef4c7868e664b2c8839f6badc67cec0,P07_JUDGE_AB,brief_18_en_landscape169,gpt-6-astra,1021,0,443,0.032360,0.000000,0.032360,31563,2026-09-18T14:00:26.795Z
chatcmpl-EPTQZRX26GSELutKpWC4fk0u5x7eH,req_0578e261d7c344a88197c762a76f67ba,P07_JUDGE_BA,brief_18_en_landscape169,gpt-6-astra,1021,0,410,0.030710,0.000000,0.030710,10979,2026-09-18T14:00:37.782Z
chatcmpl-EPTQlGbF08dDDf5ltoVbwU77tXdak,req_cfbda8a44b5a4017952bb2060d41071f,P07_CANARY_AB,brief_18_en_landscape169,gpt-6-astra,1019,0,458,0.033090,0.000000,0.033090,11346,2026-09-18T14:00:49.757Z
chatcmpl-EPTQwqcDlE9pT1PD7rysOk2u2IDF6,req_7fa8738d744f4a43afcaa3db25a4c434,P07_CANARY_BA,brief_18_en_landscape169,gpt-6-astra,1019,0,439,0.032140,0.000000,0.032140,10813,2026-09-18T14:01:00.575Z
chatcmpl-EPTR9rfBLEtlEmiXhs7MnEVSS1EPg,req_c8e574233106484083e239c18c4fc648,P03_LAYOUT,brief_19_ckb_landscape169,gpt-6-astra,4232,2500,3607,0.222670,0.022500,0.200170,49834,2026-09-18T14:01:51.081Z
chatcmpl-EPTRwGrh25vRAGb6Gj5ivHa6BGtbA,req_23c929637ba84a1196d17eb148cdc882,P05_CRITIQUE,brief_19_ckb_landscape169,gpt-6-astra,1264,0,229,0.024090,0.000000,0.024090,6669,2026-09-18T14:01:58.057Z
chatcmpl-EPTS3kepKQ4xz8fBbQNwHoBdA7lV6,req_514037c5c10e45f0b233e92006189010,P07_JUDGE_AB,brief_19_ckb_landscape169,gpt-6-astra,1016,0,483,0.034310,0.000000,0.034310,14503,2026-09-18T14:02:13.192Z
chatcmpl-EPTSOhOYq95qDpz36X3CukwQYsmag,req_23651a42a5544becb03686ceb629ead4,P07_JUDGE_BA,brief_19_ckb_landscape169,gpt-6-astra,1016,0,431,0.031710,0.000000,0.031710,17560,2026-09-18T14:02:30.758Z
chatcmpl-EPTSbbvZ9bYlNUWRY9ykAy7syJlVD,req_dcd3e8d1a91f47fda6b57642c54d6744,P07_CANARY_AB,brief_19_ckb_landscape169,gpt-6-astra,1019,0,488,0.034590,0.000000,0.034590,13151,2026-09-18T14:02:44.588Z
chatcmpl-EPTSojuulDBWPdba3GTQZCbknE899,req_a276ed2746d148de9627b893b8f8598d,P07_CANARY_BA,brief_19_ckb_landscape169,gpt-6-astra,1019,0,461,0.033240,0.000000,0.033240,13611,2026-09-18T14:02:58.205Z
chatcmpl-EPTR8NpflwJ3INw25Gx9aAx6WML71,req_b6b1c8b344d34bec8d5845ad05499dbc,P03_LAYOUT,brief_20_ckb_landscape169,gpt-6-astra,4201,2500,3614,0.222710,0.022500,0.200210,50399,2026-09-18T14:01:51.646Z
chatcmpl-EPTRwZOTftGoVQMyHy4lqH5xvisnd,req_de9651ea39ee40cd88648aa62f7e093c,P05_CRITIQUE,brief_20_ckb_landscape169,gpt-6-astra,1264,0,137,0.019490,0.000000,0.019490,5515,2026-09-18T14:01:57.444Z
chatcmpl-EPTS2lad779B6aZfn3aYE6geFQz2N,req_0e7da65fcd7b4f70aecca6b37037e4cf,P07_JUDGE_AB,brief_20_ckb_landscape169,gpt-6-astra,1021,0,445,0.032460,0.000000,0.032460,10152,2026-09-18T14:02:08.206Z
chatcmpl-EPTSCCFFxDPrxiM1mEk1zyJIobkO2,req_3c5a3562c36b46798e7f55626863f676,P07_JUDGE_BA,brief_20_ckb_landscape169,gpt-6-astra,1021,0,478,0.034110,0.000000,0.034110,12775,2026-09-18T14:02:20.989Z
chatcmpl-EPTSSdtWfaS3SmqzDTvujy6g1jyot,req_058943a8576b4e279ce4020833963cad,P07_CANARY_AB,brief_20_ckb_landscape169,gpt-6-astra,1016,0,458,0.033060,0.000000,0.033060,13691,2026-09-18T14:02:35.362Z
chatcmpl-EPTSe93Aj57pbygxgv6yA2t0MqDSP,req_7d797647150147e1973ba1309df6751c,P07_CANARY_BA,brief_20_ckb_landscape169,gpt-6-astra,1016,0,480,0.034160,0.000000,0.034160,11839,2026-09-18T14:02:47.206Z
```

---

## 3. Per-Brief Qualification Table (`P10_QUALIFICATION.csv`)

```csv
brief_id,language,size,calls,prr_pass,geometric_pass,readability_pass,asset_integrity_pass,copy_exact_pass,editability_pass,canary_won,order_swap_consistent,composite_score,cost_usd,wall_clock_ms,distinct_skeleton,archetype
brief_01_en_square,en,1080x1080,6,true,true,true,true,true,true,true,true,0.965,0.386330,110015,true,monolith_centered
brief_02_en_square,en,1080x1080,6,true,true,true,true,true,true,true,true,0.960,0.358210,103469,true,monolith_centered
brief_03_ckb_square,ckb,1080x1080,6,true,true,true,true,true,true,true,true,0.970,0.350660,105200,false,monolith_centered
brief_04_ckb_square,ckb,1080x1080,6,true,true,true,true,true,true,true,true,0.972,0.367030,109539,false,monolith_centered
brief_05_en_portrait45,en,1080x1350,6,true,true,true,true,true,true,true,true,0.960,0.358090,108039,false,monolith_centered
brief_06_en_portrait45,en,1080x1350,6,true,true,true,true,true,true,true,true,0.926,0.372040,109046,true,hero_statement_grid
brief_07_ckb_portrait45,ckb,1080x1350,8,false,false,true,true,true,true,true,true,0.933,0.472812,135070,true,monolith_centered
brief_08_ckb_portrait45,ckb,1080x1350,6,true,true,true,true,true,true,true,true,0.971,0.356460,100034,true,monolith_centered
brief_09_en_story916,en,1080x1920,6,true,true,true,true,true,true,true,true,0.963,0.335615,176432,false,monolith_centered
brief_10_en_story916,en,1080x1920,6,true,true,true,true,true,true,true,true,0.964,0.338418,179441,false,monolith_centered
brief_11_ckb_story916,ckb,1080x1920,6,true,true,true,true,true,true,true,false,0.966,0.357390,108575,false,monolith_centered
brief_12_ckb_story916,ckb,1080x1920,6,true,true,true,true,true,true,true,false,0.961,0.342830,99274,false,monolith_centered
brief_13_en_a4doc,en,1240x1754,6,true,true,true,true,true,true,true,true,0.944,0.385770,128827,true,hero_statement_grid
brief_14_en_a4doc,en,1240x1754,6,true,true,true,true,true,true,true,true,0.954,0.367275,192219,true,hero_statement_grid
brief_15_ckb_a4doc,ckb,1240x1754,6,true,true,true,true,true,true,true,true,0.973,0.359320,112910,true,monolith_centered
brief_16_ckb_a4doc,ckb,1240x1754,6,true,true,true,true,true,true,true,true,0.969,0.363160,120499,true,monolith_centered
brief_17_en_landscape169,en,1920x1080,6,true,true,true,true,true,true,true,true,0.958,0.369850,125486,false,monolith_centered
brief_18_en_landscape169,en,1920x1080,6,true,true,true,true,true,true,true,true,0.963,0.355110,129651,false,monolith_centered
brief_19_ckb_landscape169,ckb,1920x1080,6,true,true,true,true,true,true,true,true,0.969,0.358110,117306,false,monolith_centered
brief_20_ckb_landscape169,ckb,1920x1080,6,true,true,true,true,true,true,true,true,0.969,0.353490,106305,false,monolith_centered
```

---

Artifacts:
- Multi-Row Ledger: [`LEDGER.csv`](./LEDGER.csv)
- Qualification Table: [`P10_QUALIFICATION.csv`](./P10_QUALIFICATION.csv)
- Per-Brief Journals: `JOURNALS/`
