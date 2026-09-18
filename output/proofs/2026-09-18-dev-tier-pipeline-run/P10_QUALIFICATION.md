# P10 Full Qualification Report: 20 Held-Out Briefs (Multi-Stage Live Run)

**Briefs attempted:** 20 · **completed:** 20 · **failed:** 0

Verdict: **NOT A QUALIFICATION RUN.** This ran on the dev model tier (o4-mini), not the production model. Its scores describe the cheap tier and cannot be read as production evidence.

> Rates below are computed over the 20 completed briefs. A partial run is reported as partial and does NOT constitute a qualification pass.

## 1. Headline Results & Comparative Benchmarks

| Metric | Target / Published Benchmark | Pipeline Result (Multi-Stage Live Run) | Status |
| :--- | :--- | :--- | :--- |
| **Total Model Calls Recorded** | 5 calls x 20 completed briefs = 100 | **100 calls** | **PASS** |
| **Print-Ready Rate (PRR)** | 81.3% (PosterMELD, arXiv:2608.02218) | **0.0%** (0/20) | **FAIL** |
| **Median Cost per Brief** | USD 0.380 (Published Comparison) | **$0.053725** | **PASS** |
| **Canary Win Rate (Real Judge)** | >= 95.0% of completed briefs | **95.0%** (19/20) | **PASS** |
| **Order-Swap Consistency** | >= 80.0% | **70.0%** (14/20) | **FAIL** |
| **Mean Composite Score** | Measured Mean Score | **0.881** | **PASS** |
| **Canva Copy & Font Checks**| >= 90.0% of completed briefs | **0.0%** (0/20) | **FAIL** |
| **Hard-QA Escapes** | Exactly 0 | **0** | **PASS** |
| **Distinct Skeletons** | No published threshold | **5 distinct archetypes** over 20 briefs (hero_statement_grid=8, monolith_centered=7, split_statutory_banner=3, minimal_framed=1, asymmetric_editorial=1) | **MEASURED** |
| **Editability Rate** | 100.0% Verified Mutation Test | **100.0%** (20/20) | **PASS** |
| **Font Fidelity (measured at render)** | Every specified family renders exactly | **10/20 briefs rendered with a substituted face — Cinzel, Playfair Display** | **FAIL** |

> The **Distinct Skeletons** row has no numeric target in the published literature, so it is reported as measured rather than scored. The per-brief `distinct_skeleton` column in the CSV compares a brief only against the one dispatched immediately before it and is order-dependent under parallel batches; the archetype set size above is the diversity figure to read.
> **Hard-QA escapes** are counted as briefs marked print-ready while any of the geometric, readability, asset-integrity or copy-exactness checks failed.
> This run exercises the layout, critique and judge stages. No image-generation call is made, so the cost figures above are text-model costs only and do not include the art lane.
> **Font fidelity** is measured by rasterising a probe in each family and in a family that cannot exist: identical output means the renderer substituted a fallback face. `fc-match` is not a valid check, because it resolves a family name that the rasteriser then fails to use. When this row fails, the preview images are not evidence about the typography of the design.

---

## 2. Multi-Row Live Model Call Ledger (`LEDGER.csv`)
Total calls recorded: **100**

```csv
call_id,x_request_id,stage,brief_id,model,input_tokens,cached_tokens,output_tokens,gross_cost_usd,cache_discount_usd,net_cost_usd,latency_ms,timestamp
chatcmpl-EPGclkXNsdsGSqRgb8mbxq5mVA4j7,req_07d37b2c759648c5baf62dceea78b077,P03_LAYOUT,brief_01_en_square,o4-mini,3616,3456,2746,0.016060,0.002851,0.013209,19363,2026-09-18T00:20:29.689Z
chatcmpl-EPGd4JjYvcqErnHs6YRYmczFc0gAW,req_3f5c971bd79241429635ea6b235fbd4c,P05_CRITIQUE,brief_01_en_square,o4-mini-2025-04-16,3083,0,647,0.006238,0.000000,0.006238,4998,2026-09-18T00:20:34.990Z
chatcmpl-EPGdAdnctVG0lDOa9zCkptqowh1gx,req_9ffb9010516a4df0b5f508ca41aead63,P07_JUDGE_AB,brief_01_en_square,o4-mini-2025-04-16,4664,0,530,0.007462,0.000000,0.007462,4921,2026-09-18T00:20:46.443Z
chatcmpl-EPGdFNxwIkO3FcBFsngXbbI1iulCL,req_c50282a65e3e417087093f9a972dcf73,P07_JUDGE_BA,brief_01_en_square,o4-mini-2025-04-16,4664,0,614,0.007832,0.000000,0.007832,5108,2026-09-18T00:20:46.443Z
chatcmpl-EPGdLWixVQfNsMgbqg4rwVK3LaDgb,req_70ff32c42f174c3081b02cad28957920,P07_CANARY,brief_01_en_square,o4-mini-2025-04-16,4666,0,496,0.007315,0.000000,0.007315,3832,2026-09-18T00:20:50.985Z
chatcmpl-EPGclKgxvXHT00C8YGLOSI47dinle,req_dd47c64525a4410d833cc323a8ce5575,P03_LAYOUT,brief_02_en_square,o4-mini,3579,3456,2234,0.013766,0.002851,0.010915,16481,2026-09-18T00:20:26.835Z
chatcmpl-EPGd3kqmRJNZTx5RkLLnsb2jAymNN,req_55d0e66ed983418cb43f56d360677dc6,P05_CRITIQUE,brief_02_en_square,o4-mini-2025-04-16,3016,0,708,0.006433,0.000000,0.006433,5227,2026-09-18T00:20:34.258Z
chatcmpl-EPGd98rSGLDPqMgDxPjEmsWbTTecC,req_d2e0e5d49d284863ab81327a4d6badb8,P07_JUDGE_AB,brief_02_en_square,o4-mini-2025-04-16,4667,0,657,0.008025,0.000000,0.008025,4901,2026-09-18T00:20:45.694Z
chatcmpl-EPGdFlBzSQm7KEN5icvUnVVwx6G4k,req_d8fff671d3924ebaa5e33b9d0d9e317d,P07_JUDGE_BA,brief_02_en_square,o4-mini-2025-04-16,4667,0,727,0.008332,0.000000,0.008332,5062,2026-09-18T00:20:45.695Z
chatcmpl-EPGdLTWKo04A4EZZco5W4TMjDExF6,req_cdfa85bfa3ee45a9a5d6ee3be9ef6a6b,P07_CANARY,brief_02_en_square,o4-mini-2025-04-16,4667,0,620,0.007862,0.000000,0.007862,5291,2026-09-18T00:20:51.733Z
chatcmpl-EPGdQoZ9kHLdYVEMTA7QU1cR65C20,req_b255c2c3bc824fd8b81fda213769bc5c,P03_LAYOUT,brief_03_ckb_square,o4-mini,3789,3712,2572,0.015485,0.003062,0.012422,16034,2026-09-18T00:21:08.521Z
chatcmpl-EPGdhWLUCgixbBhG8IHwsAjmaYDBr,req_f895388be1ff4cb4a73a748f5b884d06,P05_CRITIQUE,brief_03_ckb_square,o4-mini-2025-04-16,3050,0,776,0.006769,0.000000,0.006769,5365,2026-09-18T00:21:14.187Z
chatcmpl-EPGdnYXXtGzYr878VgJsxtXa1MeSO,req_29e91ec0f79a4eb98ecfaaadfce4e1ed,P07_JUDGE_AB,brief_03_ckb_square,o4-mini-2025-04-16,4667,0,500,0.007334,0.000000,0.007334,4483,2026-09-18T00:21:24.580Z
chatcmpl-EPGdsmJEksA4ml1rkYhnIgIjYn5jt,req_f103314946c04210a155c008bcecbea4,P07_JUDGE_BA,brief_03_ckb_square,o4-mini-2025-04-16,4667,0,539,0.007505,0.000000,0.007505,4466,2026-09-18T00:21:24.580Z
chatcmpl-EPGdxGut6N9QmnO5HKhrbzYC7gGz5,req_2449673805f7414994b34a6870004d35,P07_CANARY,brief_03_ckb_square,o4-mini-2025-04-16,4674,0,576,0.007676,0.000000,0.007676,4304,2026-09-18T00:21:29.609Z
chatcmpl-EPGdQSeIk9AYtFEvOlQKHgbn1pxRC,req_02a1f65691544e579020371883d915e2,P03_LAYOUT,brief_04_ckb_square,o4-mini,3801,3712,2342,0.014486,0.003062,0.011424,14527,2026-09-18T00:21:07.044Z
chatcmpl-EPGdfsagniCwjWzLrwebCmzDqkhni,req_29be39ba31b247c8b697351d40123758,P05_CRITIQUE,brief_04_ckb_square,o4-mini-2025-04-16,3050,0,853,0.007108,0.000000,0.007108,5930,2026-09-18T00:21:13.348Z
chatcmpl-EPGdmN8Ygnf01CDFzT4GXh5HTqyCk,req_ef490882e6e9474ea0554f8592504ce4,P07_JUDGE_AB,brief_04_ckb_square,o4-mini-2025-04-16,4671,0,562,0.007611,0.000000,0.007611,4583,2026-09-18T00:21:23.856Z
chatcmpl-EPGdrSlPh7OwYVzifi99OcsGSU7iL,req_3880a1b4d8e945bd95f2d4603f390dde,P07_JUDGE_BA,brief_04_ckb_square,o4-mini-2025-04-16,4671,0,620,0.007866,0.000000,0.007866,4453,2026-09-18T00:21:23.856Z
chatcmpl-EPGdwIZpDzcjXkRoAMyMgnaUMirjC,req_3a8d4c037240480f9c2e63f7ae517ba2,P07_CANARY,brief_04_ckb_square,o4-mini-2025-04-16,4667,0,525,0.007444,0.000000,0.007444,4247,2026-09-18T00:21:28.826Z
chatcmpl-EPGe2ResRfITmx56oh2FxFMWuiC8v,req_04326d0d44bb45e8a5d2247f071a5422,P03_LAYOUT,brief_05_en_portrait45,o4-mini,3632,3456,2291,0.014076,0.002851,0.011224,13609,2026-09-18T00:21:43.992Z
chatcmpl-EPGeGnfWQ5PDksGEHTtCHg3iAvS88,req_85e1c04dadba42f09eb8b1c140b7b280,P05_CRITIQUE,brief_05_en_portrait45,o4-mini-2025-04-16,3573,0,706,0.007037,0.000000,0.007037,5305,2026-09-18T00:21:49.653Z
chatcmpl-EPGeNxSCgaGoT9lGiNLyjYiCLvAsR,req_170671ceba264c3ea77dc2e4a1223fdc,P07_JUDGE_AB,brief_05_en_portrait45,o4-mini-2025-04-16,5721,0,635,0.009087,0.000000,0.009087,5211,2026-09-18T00:22:01.009Z
chatcmpl-EPGeSpxvbFmoMNRcPZqv5LFthL52x,req_77ead5a64a174aa9815101a6d6ea87ba,P07_JUDGE_BA,brief_05_en_portrait45,o4-mini-2025-04-16,5721,0,633,0.009078,0.000000,0.009078,4660,2026-09-18T00:22:01.009Z
chatcmpl-EPGeYZ6HpogqcITYqpU1qswJnt6gP,req_ae1e00ab17434035bda15be933e6a394,P07_CANARY,brief_05_en_portrait45,o4-mini-2025-04-16,5723,0,530,0.008627,0.000000,0.008627,4390,2026-09-18T00:22:06.156Z
chatcmpl-EPGe2KgTJIS05b6imDWadt62HY8Rf,req_58487fdd716743be8f453ed697e220a2,P03_LAYOUT,brief_06_en_portrait45,o4-mini,3630,3456,2819,0.016397,0.002851,0.013545,16590,2026-09-18T00:21:46.968Z
chatcmpl-EPGeKSIi5QTQ6nWmPFkRqmklicFeZ,req_c1796de9439845a6a8b590a51b5fa993,P05_CRITIQUE,brief_06_en_portrait45,o4-mini-2025-04-16,3578,0,975,0.008226,0.000000,0.008226,7553,2026-09-18T00:21:54.835Z
chatcmpl-EPGeRsS9x0cj0VwuSO36Xo1eSGj1Z,req_3ec97a8b5a044891b693cdeabaaeb806,P07_JUDGE_AB,brief_06_en_portrait45,o4-mini-2025-04-16,5717,0,602,0.008937,0.000000,0.008937,4286,2026-09-18T00:22:05.281Z
chatcmpl-EPGeXwh8490R13AmenQ2hgTDrEKHZ,req_12994daf16b24c7899eb116e29651402,P07_JUDGE_BA,brief_06_en_portrait45,o4-mini-2025-04-16,5717,0,571,0.008801,0.000000,0.008801,4626,2026-09-18T00:22:05.281Z
chatcmpl-EPGec0KnGLwrFCKLq4XXJ0JznyEZH,req_6eb5ba6d0e244d779df1ab26dd427167,P07_CANARY,brief_06_en_portrait45,o4-mini-2025-04-16,5723,0,633,0.009081,0.000000,0.009081,5180,2026-09-18T00:22:11.223Z
chatcmpl-EPGejSgsGGFmw342SeYP8J4d6rdsP,req_ed65af5abc6541bd9821212fd1b3ce26,P03_LAYOUT,brief_07_ckb_portrait45,o4-mini,3885,3712,3263,0.018631,0.003062,0.015568,20291,2026-09-18T00:22:32.409Z
chatcmpl-EPGf3MMTMTJfROHk187oyz4V1kcbq,req_28d1b412706d4036ab8effba2d9dff4b,P05_CRITIQUE,brief_07_ckb_portrait45,o4-mini-2025-04-16,3602,0,856,0.007729,0.000000,0.007729,6244,2026-09-18T00:22:38.954Z
chatcmpl-EPGfArlVfaAp1wgftIzBmAEaMgRLy,req_3b01477d31f74159ba9fc51981c80cc3,P07_JUDGE_AB,brief_07_ckb_portrait45,o4-mini-2025-04-16,5710,0,622,0.009018,0.000000,0.009018,5271,2026-09-18T00:22:51.279Z
chatcmpl-EPGfGiFqOdxl3cYoAprWMmn9VzTDs,req_e7a22574232a4028ac2d9e0162741155,P07_JUDGE_BA,brief_07_ckb_portrait45,o4-mini-2025-04-16,5710,0,794,0.009775,0.000000,0.009775,5555,2026-09-18T00:22:51.279Z
chatcmpl-EPGfMlXiULq9HP43ELotk6lIouljn,req_7433b4b30c1943aa83852386299cde5d,P07_CANARY,brief_07_ckb_portrait45,o4-mini-2025-04-16,5716,0,514,0.008549,0.000000,0.008549,4179,2026-09-18T00:22:56.214Z
chatcmpl-EPGeiW3TEDqhpiRXOSz6qVMm8tl8R,req_56c1b74794424da9b45c8e4bc8300620,P03_LAYOUT,brief_08_ckb_portrait45,o4-mini,3844,3712,2693,0.016078,0.003062,0.013015,16106,2026-09-18T00:22:28.215Z
chatcmpl-EPGeyEc8BlW9VhwbCJxooFmb4WRWa,req_9bd6b671310945a3988bbc7339d937b7,P05_CRITIQUE,brief_08_ckb_portrait45,o4-mini-2025-04-16,3578,0,991,0.008296,0.000000,0.008296,7514,2026-09-18T00:22:36.116Z
chatcmpl-EPGf7Ln4fUqAEvFHoj6yjLsUueeKI,req_6dbad6009b52442e87f034ce01cc519e,P07_JUDGE_AB,brief_08_ckb_portrait45,o4-mini-2025-04-16,5720,0,734,0.009522,0.000000,0.009522,5377,2026-09-18T00:22:48.203Z
chatcmpl-EPGfDway2O3oL8n4tDirhf0hmhVc2,req_10e293725f724371a900499e36858940,P07_JUDGE_BA,brief_08_ckb_portrait45,o4-mini-2025-04-16,5720,0,574,0.008818,0.000000,0.008818,5209,2026-09-18T00:22:48.203Z
chatcmpl-EPGfJjHSP4atlPkY42h6QCCoipSKP,req_2a7d1d6aca75430b8f15abca84cadccc,P07_CANARY,brief_08_ckb_portrait45,o4-mini-2025-04-16,5724,0,435,0.008210,0.000000,0.008210,3799,2026-09-18T00:22:52.783Z
chatcmpl-EPGfRo3ak40jPZST9hqvsDrFgZjPy,req_0b47963dacc1423291c212bc0338bd96,P03_LAYOUT,brief_09_en_story916,o4-mini,3610,3456,2221,0.013743,0.002851,0.010892,13832,2026-09-18T00:23:10.851Z
chatcmpl-EPGffCzsLq0otsbpEXm1rshMzpAnF,req_3f26cfa0f3514cb8b2959b93ea16f756,P05_CRITIQUE,brief_09_en_story916,o4-mini-2025-04-16,4573,0,921,0.009083,0.000000,0.009083,6745,2026-09-18T00:23:17.926Z
chatcmpl-EPGfngADx8d7fiXspsJmK5f2s7HvA,req_669423ebb1ea436daee15ab1a58845f8,P07_JUDGE_AB,brief_09_en_story916,o4-mini-2025-04-16,7708,0,542,0.010864,0.000000,0.010864,5234,2026-09-18T00:23:28.966Z
chatcmpl-EPGftX6GUC7v3h5DnH19PKfImqVKy,req_6f1e171b8ddd47c0b822baeec84233dc,P07_JUDGE_BA,brief_09_en_story916,o4-mini-2025-04-16,7708,0,574,0.011004,0.000000,0.011004,4193,2026-09-18T00:23:28.966Z
chatcmpl-EPGfyXrYLr9w41d6CHynIrCrAb8a6,req_dadbe01a8a6d4ce7bbce8db8c4ab733e,P07_CANARY,brief_09_en_story916,o4-mini-2025-04-16,7707,0,637,0.011281,0.000000,0.011281,4583,2026-09-18T00:23:34.387Z
chatcmpl-EPGfS3AXOVTO9zaTdadsS70gjZibZ,req_763599c8384f4afe9e7b4ca200593c47,P03_LAYOUT,brief_10_en_story916,o4-mini,3593,3456,3032,0.017293,0.002851,0.014442,20149,2026-09-18T00:23:17.163Z
chatcmpl-EPGfmpVzFJCd0vghdYcsXKcwDjcGd,req_8cf618d790124f6f8e71de9b3f6b6fd9,P05_CRITIQUE,brief_10_en_story916,o4-mini-2025-04-16,4569,0,710,0.008150,0.000000,0.008150,5636,2026-09-18T00:23:23.129Z
chatcmpl-EPGfsRaIDiDML1N4M2FwZlFkRmUmb,req_0afa014235e14a04a443e8191935d9bb,P07_JUDGE_AB,brief_10_en_story916,o4-mini-2025-04-16,7705,0,506,0.010702,0.000000,0.010702,4174,2026-09-18T00:23:32.908Z
chatcmpl-EPGfxnAuGmj2pE2d3Ra7p6z3YF7Iq,req_795677d837a741a0a0094fd993b349fe,P07_JUDGE_BA,brief_10_en_story916,o4-mini-2025-04-16,7705,0,489,0.010627,0.000000,0.010627,3944,2026-09-18T00:23:32.908Z
chatcmpl-EPGg2SHa1RU4rUeK2EHjZIUUE6SoC,req_5f7bab6e2e174208bea03331d92e7097,P07_CANARY,brief_10_en_story916,o4-mini-2025-04-16,7701,0,489,0.010623,0.000000,0.010623,3648,2026-09-18T00:23:37.404Z
chatcmpl-EPGg69GDi4yCua6O3JYvfmrmx5qKg,req_231923ce70654998b5d16eaada32b588,P03_LAYOUT,brief_11_ckb_story916,o4-mini,3821,3712,2842,0.016708,0.003062,0.013646,16832,2026-09-18T00:23:55.102Z
chatcmpl-EPGgN9VQRtMa8519HF2bPEJfSzZnO,req_c6ee99b501414c4ba8ebe84b2ff56f29,P05_CRITIQUE,brief_11_ckb_story916,o4-mini-2025-04-16,4570,0,884,0.008917,0.000000,0.008917,6069,2026-09-18T00:24:01.499Z
chatcmpl-EPGgUlEBIdFoBCSQHeydDIOHmMzVc,req_e6ab1852284545ab8717c44ff5030c70,P07_JUDGE_AB,brief_11_ckb_story916,o4-mini-2025-04-16,7704,0,677,0.011453,0.000000,0.011453,4957,2026-09-18T00:24:12.329Z
chatcmpl-EPGgaPqsbdZzOG9bjRoI7mXrjqHAT,req_e2e2304adf004706bcba412891b31045,P07_JUDGE_BA,brief_11_ckb_story916,o4-mini-2025-04-16,7704,0,442,0.010419,0.000000,0.010419,4163,2026-09-18T00:24:12.329Z
chatcmpl-EPGgfXvnTh4svcHYfrePvaXn6vXV4,req_ba0d0c3b44084ce5bcca769a5cb7dd43,P07_CANARY,brief_11_ckb_story916,o4-mini-2025-04-16,7702,0,627,0.011231,0.000000,0.011231,5708,2026-09-18T00:24:18.881Z
chatcmpl-EPGg6NXXrj5MziOJePiXwfAHC3229,req_514bd42007af4e5daf8d8a62e57b8ca3,P03_LAYOUT,brief_12_ckb_story916,o4-mini,3785,3712,3168,0.018103,0.003062,0.015040,18593,2026-09-18T00:23:56.862Z
chatcmpl-EPGgPqKdad3wzFNQn7xK48LCVtXFg,req_3cf9cca2ff3d46c09ba74d06deae8447,P05_CRITIQUE,brief_12_ckb_story916,o4-mini-2025-04-16,4539,0,800,0.008513,0.000000,0.008513,5449,2026-09-18T00:24:02.630Z
chatcmpl-EPGgVLwxZdQiOyWUgJGzx8B8RYID2,req_980c92975c814fbc8eb41609a3a8bedd,P07_JUDGE_AB,brief_12_ckb_story916,o4-mini-2025-04-16,7706,0,627,0.011235,0.000000,0.011235,4705,2026-09-18T00:24:13.475Z
chatcmpl-EPGgbC3vrE91tDEEWyQ3epD7WuRyQ,req_255923231b5640afb545ccc3706670f3,P07_JUDGE_BA,brief_12_ckb_story916,o4-mini-2025-04-16,7706,0,524,0.010782,0.000000,0.010782,4468,2026-09-18T00:24:13.475Z
chatcmpl-EPGgguFKfOAa4rTFT2wed3nK7FXTE,req_3f083a387c784558a103d70f17bd0930,P07_CANARY,brief_12_ckb_story916,o4-mini-2025-04-16,7707,0,392,0.010202,0.000000,0.010202,3707,2026-09-18T00:24:18.019Z
chatcmpl-EPGgmKOiQqRpVmdsUaaqlVUsl5A1b,req_8de4419a45c244ae9561344fb7ea708f,P03_LAYOUT,brief_13_en_a4doc,o4-mini,3664,3584,2453,0.014824,0.002957,0.011867,15941,2026-09-18T00:24:35.693Z
chatcmpl-EPGh2ysAKytVW18G4Au2hFcdu1gH2,req_a51e341dc7b744eaa87f4b45452664e6,P05_CRITIQUE,brief_13_en_a4doc,o4-mini-2025-04-16,4758,0,1029,0.009761,0.000000,0.009761,7774,2026-09-18T00:24:43.794Z
chatcmpl-EPGhBJJcWbPOvQ6s2HJ0S2c5Q6BNA,req_4c46ee5f27b247bdba66af93d1e7068f,P07_JUDGE_AB,brief_13_en_a4doc,o4-mini-2025-04-16,8070,0,571,0.011389,0.000000,0.011389,4806,2026-09-18T00:24:55.134Z
chatcmpl-EPGhHgwcJu36vPjhS1JtdKVv3IQ2p,req_6607bf4043a44e9ea833d5349fbc4acd,P07_JUDGE_BA,brief_13_en_a4doc,o4-mini-2025-04-16,8070,0,575,0.011407,0.000000,0.011407,4887,2026-09-18T00:24:55.134Z
chatcmpl-EPGhM2348ZSOoFKCglAhiCOfENiD6,req_f167f3ecc88f467d92862e635cc77f8a,P07_CANARY,brief_13_en_a4doc,o4-mini-2025-04-16,8077,0,542,0.011270,0.000000,0.011270,4706,2026-09-18T00:25:00.661Z
chatcmpl-EPGgm56n8PUyhpDbfChgj2xs2C97s,req_1d841d0de23d47d798165b6ab6537283,P03_LAYOUT,brief_14_en_a4doc,o4-mini,3614,3456,2843,0.016485,0.002851,0.013633,18218,2026-09-18T00:24:37.971Z
chatcmpl-EPGh5p8ytNET5yRV5p20lptvJmLfE,req_ce69e75c61994cacb5d8a9015c5c2a9b,P05_CRITIQUE,brief_14_en_a4doc,o4-mini-2025-04-16,4756,0,1039,0.009803,0.000000,0.009803,7960,2026-09-18T00:24:46.262Z
chatcmpl-EPGhDFEiz0owqsvjtdqlBQaJBjBNM,req_56508475f3a8469cb47bae6b2bd04ec1,P07_JUDGE_AB,brief_14_en_a4doc,o4-mini-2025-04-16,8064,0,473,0.010952,0.000000,0.010952,4313,2026-09-18T00:24:56.432Z
chatcmpl-EPGhIyFL0tciA4ePfA2AGuqDKacVw,req_fceecd715ee34016be7e77745dea97d3,P07_JUDGE_BA,brief_14_en_a4doc,o4-mini-2025-04-16,8064,0,411,0.010679,0.000000,0.010679,4228,2026-09-18T00:24:56.432Z
chatcmpl-EPGhN4Keg8sIPkZDSQPFGJTVnbWcF,req_9a69e6f3d52d480aad0bd8e30cf15172,P07_CANARY,brief_14_en_a4doc,o4-mini-2025-04-16,8073,0,477,0.010979,0.000000,0.010979,4337,2026-09-18T00:25:01.606Z
chatcmpl-EPGhSiPHKMp6ZQexEId4qSEcIsmOw,req_7dd26a462ae849ef93babe458461d376,P03_LAYOUT,brief_15_ckb_a4doc,o4-mini,3851,3712,2316,0.014427,0.003062,0.011364,17075,2026-09-18T00:25:19.553Z
chatcmpl-EPGhkaQIWzuZ7VNhHepvsnPuzm33U,req_b622c0014565441ba9329a90078d5e2c,P05_CRITIQUE,brief_15_ckb_a4doc,o4-mini-2025-04-16,4752,0,804,0.008765,0.000000,0.008765,5331,2026-09-18T00:25:25.200Z
chatcmpl-EPGhqJqumNrGju5oIpyjq6zCOqzPN,req_6eea3dd0bd3242d69327bb3759953883,P07_JUDGE_AB,brief_15_ckb_a4doc,o4-mini-2025-04-16,8073,0,587,0.011463,0.000000,0.011463,4937,2026-09-18T00:25:36.475Z
chatcmpl-EPGhwXJrnBkA27YYznZzi85RTtgaI,req_65c20d1f7b7d465bbb5d17080cbcaf19,P07_JUDGE_BA,brief_15_ckb_a4doc,o4-mini-2025-04-16,8073,0,658,0.011776,0.000000,0.011776,4758,2026-09-18T00:25:36.475Z
chatcmpl-EPGi11VxKOIh0WJXEqyD6EpeStxkO,req_5044919ac05b4161b1528a235964496a,P07_CANARY,brief_15_ckb_a4doc,o4-mini-2025-04-16,8066,0,623,0.011614,0.000000,0.011614,4527,2026-09-18T00:25:41.788Z
chatcmpl-EPGhSEmtIqEzcP3JmkVjhwc4fzZVM,req_4addd21431234a77969f127f12ed1a57,P03_LAYOUT,brief_16_ckb_a4doc,o4-mini,3810,3712,2537,0.015354,0.003062,0.012291,18006,2026-09-18T00:25:20.477Z
chatcmpl-EPGhlYGXXgTNTzflE1XDobdNe9Pbv,req_6262f5a9a2604b0188ac705727be0728,P05_CRITIQUE,brief_16_ckb_a4doc,o4-mini-2025-04-16,4787,0,914,0.009287,0.000000,0.009287,7015,2026-09-18T00:25:27.805Z
chatcmpl-EPGhsmhZbqR62ZOatdrhsI80w2pdc,req_763255f2c8584b94ba64152e75f49bdf,P07_JUDGE_AB,brief_16_ckb_a4doc,o4-mini-2025-04-16,8060,0,514,0.011128,0.000000,0.011128,4158,2026-09-18T00:25:37.831Z
chatcmpl-EPGhxcmpMq6mUGP410NVj6lQR7ZHA,req_61f39a164c794f85a710d7a9229fe189,P07_JUDGE_BA,brief_16_ckb_a4doc,o4-mini-2025-04-16,8060,0,534,0.011216,0.000000,0.011216,4222,2026-09-18T00:25:37.831Z
chatcmpl-EPGi2ZfZK8DusXL3NNKU7ptfzGZir,req_6c7646e5b2de4feebf6597cf2e6efe57,P07_CANARY,brief_16_ckb_a4doc,o4-mini-2025-04-16,8058,0,627,0.011623,0.000000,0.011623,4731,2026-09-18T00:25:43.376Z
chatcmpl-EPGi8F8ZLGY6moEE5Ww8DyOTHR955,req_82f6d48ae39a4a018afa63ed23967f1c,P03_LAYOUT,brief_17_en_landscape169,o4-mini,3625,3456,3308,0.018543,0.002851,0.015692,21789,2026-09-18T00:26:06.008Z
chatcmpl-EPGiUhT1MBURHtbAWvFcCUX9Aa9ZA,req_d65b9a93bea2485d9a1ffa66f7f9f1ca,P05_CRITIQUE,brief_17_en_landscape169,o4-mini-2025-04-16,4602,0,960,0.009286,0.000000,0.009286,6832,2026-09-18T00:26:13.171Z
chatcmpl-EPGicCnwQU0FyuDLjSb1QsYlZkCS6,req_abed188f5cf5456397b6d7be3faf01e0,P07_JUDGE_AB,brief_17_en_landscape169,o4-mini-2025-04-16,7708,0,612,0.011172,0.000000,0.011172,5062,2026-09-18T00:26:24.300Z
chatcmpl-EPGiimv9Pi8qHC2ZPSG3lr6UTs3RB,req_aef1c420199b4775bb03044cacfb97c2,P07_JUDGE_BA,brief_17_en_landscape169,o4-mini-2025-04-16,7708,0,563,0.010956,0.000000,0.010956,4443,2026-09-18T00:26:24.300Z
chatcmpl-EPGinLe5dkNvxwCCBZ9SBsMWOMbo6,req_2cd38a9561994df9aac0fe720d0a6197,P07_CANARY,brief_17_en_landscape169,o4-mini-2025-04-16,7707,0,439,0.010409,0.000000,0.010409,4282,2026-09-18T00:26:29.431Z
chatcmpl-EPGi8B4WMemXwBCzAmsfu12Bepzds,req_a2226c3445764beeb9e4ac3783a5bf6b,P03_LAYOUT,brief_18_en_landscape169,o4-mini,3600,3456,3058,0.017415,0.002851,0.014564,20363,2026-09-18T00:26:04.579Z
chatcmpl-EPGiTbuD7xNyknf9nW17huRlynq2j,req_3a1dd9067dc340eebab52092a823c233,P05_CRITIQUE,brief_18_en_landscape169,o4-mini-2025-04-16,4573,0,599,0.007666,0.000000,0.007666,5118,2026-09-18T00:26:10.031Z
chatcmpl-EPGiZAL2MFhD8Nmg6croJ7TnEnCtX,req_67628cd346584319b8c8bdf7237b6860,P07_JUDGE_AB,brief_18_en_landscape169,o4-mini-2025-04-16,7701,0,603,0.011124,0.000000,0.011124,4774,2026-09-18T00:26:21.153Z
chatcmpl-EPGifLI02e4a7reqDihAk6gyPtor0,req_29c539bf54c3468fa19fc25885202846,P07_JUDGE_BA,brief_18_en_landscape169,o4-mini-2025-04-16,7701,0,562,0.010944,0.000000,0.010944,4715,2026-09-18T00:26:21.153Z
chatcmpl-EPGikzFlQ82gzPGxS3D9s5gw7VXMO,req_1e7db14b93a24c50a473225ab4d12f02,P07_CANARY,brief_18_en_landscape169,o4-mini-2025-04-16,7701,0,561,0.010939,0.000000,0.010939,4645,2026-09-18T00:26:26.605Z
chatcmpl-EPGisduEFOMv509sdVSH2JjtEIyUD,req_aa402a6c46f54398ac35c55ec4cb3957,P03_LAYOUT,brief_19_ckb_landscape169,o4-mini,3840,3712,2172,0.013781,0.003062,0.010718,13745,2026-09-18T00:26:44.041Z
chatcmpl-EPGj6IPaxdzGNZhWc8viJNmH9ZHjx,req_c483042515324b67bed7756bc9a890c9,P05_CRITIQUE,brief_19_ckb_landscape169,o4-mini-2025-04-16,4576,0,994,0.009407,0.000000,0.009407,8203,2026-09-18T00:26:52.560Z
chatcmpl-EPGjFtxlG0VyVUMiVLhFzHqB1EGOs,req_2d495c831b1a4b2a9fc33b284bd1c8ef,P07_JUDGE_AB,brief_19_ckb_landscape169,o4-mini-2025-04-16,7707,0,452,0.010467,0.000000,0.010467,3832,2026-09-18T00:27:02.843Z
chatcmpl-EPGjKHUAWzsza2Py1oVYDTpvX7xhY,req_d31968e118554a13baf7732317a564aa,P07_JUDGE_BA,brief_19_ckb_landscape169,o4-mini-2025-04-16,7707,0,568,0.010977,0.000000,0.010977,4816,2026-09-18T00:27:02.843Z
chatcmpl-EPGjRcoAD8UGHibsqMnAfA4W3prl4,req_f41073b8ed324d89b6c92eac3b3f2620,P07_CANARY,brief_19_ckb_landscape169,o4-mini-2025-04-16,7707,0,536,0.010836,0.000000,0.010836,5345,2026-09-18T00:27:09.034Z
chatcmpl-EPGis4izaiW13jKdwmbAmsPPGBuf1,req_cc9e4bf1f91044d991e15db7f5fb27c7,P03_LAYOUT,brief_20_ckb_landscape169,o4-mini,3809,3712,2527,0.015309,0.003062,0.012246,16009,2026-09-18T00:26:46.298Z
chatcmpl-EPGj84HHaQFAK0WgIvXckykaMtOPX,req_6e09c07d02644243a63dfe4c063df2a2,P05_CRITIQUE,brief_20_ckb_landscape169,o4-mini-2025-04-16,4578,0,939,0.009167,0.000000,0.009167,7263,2026-09-18T00:26:53.875Z
chatcmpl-EPGjHom4EKAR7hRmA5Z3glQVVn5KK,req_4e0535b214284e8e888dbf495f5cdeba,P07_JUDGE_AB,brief_20_ckb_landscape169,o4-mini-2025-04-16,7708,0,619,0.011202,0.000000,0.011202,5510,2026-09-18T00:27:05.600Z
chatcmpl-EPGjNu9UGgZc8akjC2r913lby4wbQ,req_c593875519524e78b44be2e2be83e673,P07_JUDGE_BA,brief_20_ckb_landscape169,o4-mini-2025-04-16,7708,0,590,0.011075,0.000000,0.011075,4630,2026-09-18T00:27:05.600Z
chatcmpl-EPGjTNtMcef7ZbBhtkldpeusijsam,req_7fb3f87e4add48a7a2c322afe222aa21,P07_CANARY,brief_20_ckb_landscape169,o4-mini-2025-04-16,7709,0,490,0.010636,0.000000,0.010636,4302,2026-09-18T00:27:10.715Z
```

---

## 3. Per-Brief Qualification Table (`P10_QUALIFICATION.csv`)

```csv
brief_id,language,size,calls,prr_pass,geometric_pass,readability_pass,asset_integrity_pass,copy_exact_pass,editability_pass,canary_won,order_swap_consistent,composite_score,cost_usd,wall_clock_ms,distinct_skeleton,archetype
brief_01_en_square,en,1080x1080,5,false,false,false,true,true,true,true,true,0.866,0.042056,41052,true,split_statutory_banner
brief_02_en_square,en,1080x1080,5,false,false,false,true,true,true,true,false,0.872,0.041567,41766,true,hero_statement_grid
brief_03_ckb_square,ckb,1080x1080,5,false,false,false,true,true,true,true,false,0.847,0.041706,37533,true,minimal_framed
brief_04_ckb_square,ckb,1080x1080,5,false,false,false,true,true,true,true,true,0.845,0.041453,36778,true,monolith_centered
brief_05_en_portrait45,en,1080x1350,5,false,false,false,true,true,true,true,true,0.809,0.045053,36167,true,split_statutory_banner
brief_06_en_portrait45,en,1080x1350,5,false,true,false,true,true,true,true,true,0.874,0.048590,41268,true,hero_statement_grid
brief_07_ckb_portrait45,ckb,1080x1350,5,false,true,false,true,true,true,true,true,0.934,0.050639,44541,false,hero_statement_grid
brief_08_ckb_portrait45,ckb,1080x1350,5,false,true,false,true,true,true,true,false,0.914,0.047861,41096,false,hero_statement_grid
brief_09_en_story916,en,1080x1920,5,false,false,false,true,true,true,true,false,0.885,0.053124,37789,true,monolith_centered
brief_10_en_story916,en,1080x1920,5,false,false,false,true,true,true,true,true,0.899,0.054544,40815,true,monolith_centered
brief_11_ckb_story916,ckb,1080x1920,5,false,true,false,true,true,true,true,false,0.954,0.055666,41057,true,hero_statement_grid
brief_12_ckb_story916,ckb,1080x1920,5,false,false,false,true,true,true,true,true,0.891,0.055772,40188,false,monolith_centered
brief_13_en_a4doc,en,1240x1754,5,false,false,false,true,true,true,false,true,0.893,0.055694,41329,true,hero_statement_grid
brief_14_en_a4doc,en,1240x1754,5,false,true,false,true,true,true,true,true,0.873,0.056046,42279,true,hero_statement_grid
brief_15_ckb_a4doc,ckb,1240x1754,5,false,false,false,true,true,true,true,true,0.842,0.054982,39772,true,monolith_centered
brief_16_ckb_a4doc,ckb,1240x1754,5,false,true,false,true,true,true,true,true,0.942,0.055545,41362,true,split_statutory_banner
brief_17_en_landscape169,en,1920x1080,5,false,true,false,true,true,true,true,true,0.878,0.057515,45648,true,asymmetric_editorial
brief_18_en_landscape169,en,1920x1080,5,false,false,false,true,true,true,true,true,0.893,0.055237,42805,true,monolith_centered
brief_19_ckb_landscape169,ckb,1920x1080,5,false,false,false,true,true,true,true,false,0.841,0.052405,39196,false,monolith_centered
brief_20_ckb_landscape169,ckb,1920x1080,5,false,false,false,true,true,true,true,true,0.872,0.054326,40842,true,hero_statement_grid
```

---

Artifacts:
- Multi-Row Ledger: [`LEDGER.csv`](./LEDGER.csv)
- Qualification Table: [`P10_QUALIFICATION.csv`](./P10_QUALIFICATION.csv)
- Per-Brief Journals: `JOURNALS/`
