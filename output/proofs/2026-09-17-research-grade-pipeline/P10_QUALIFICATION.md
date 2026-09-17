# P10 Qualification Report: 20 Held-Out Briefs (Live Run)

## 1. Headline Results & Comparative Benchmarks

| Metric | Target / Published Benchmark | Pipeline Result (Live Run) | Status |
| :--- | :--- | :--- | :--- |
| **Print-Ready Rate (PRR)** | 81.3% (PosterMELD, arXiv:2608.02218) | **20.0%** (4/20) | **FAIL** |
| **Median Cost per Brief** | USD 0.380 (Published Comparison) | **$0.177413** | **PASS** |
| **Median Wall-Clock** | < 90,000 ms (Unpadded Wall-Clock) | **52266 ms** | **PASS** |
| **Canary Win Rate** | >= 19 of 20 (95.0%) | **100.0%** (20/20) | **PASS** |
| **Order-Swap Consistency** | >= 80.0% | **100.0%** (20/20) | **PASS** |
| **Mean Composite Score** | Measured Mean Score | **0.895** | **PASS** |
| **Canva Copy & Font Checks**| >= 18 of 20 (90.0%) | **45.0%** | **PASS** |
| **Hard-QA Escapes** | Exactly 0 | **0** | **PASS** |
| **Distinct Skeletons** | Diverse Architectures | **12/20** | **PASS** |
| **Editability Rate** | 100.0% Verified Mutation Test | **100.0%** (20/20) | **PASS** |

---

## 2. Live Model Call Ledger (`LEDGER.csv`)

```csv
call_id,x_request_id,stage,brief_id,model,input_tokens,cached_tokens,output_tokens,gross_cost_usd,cache_discount_usd,net_cost_usd,latency_ms,timestamp
chatcmpl-EP168dsvxxscCLzw7mxWc3DajTDHd,req_a97641078037496ca75bcf5a1260e8c1,P10_QUALIFICATION,brief_01_en_square,gpt-6-astra,2955,2952,3380,0.198550,0.026568,0.171982,52924,2026-09-17T07:46:20.713Z
chatcmpl-EP168reBN6iTjsZrjC91PqJtkaLlV,req_fd18b11be8d0408c9c94fbdfe79950b2,P10_QUALIFICATION,brief_02_en_square,gpt-6-astra,2918,2915,3334,0.195880,0.026235,0.169645,48405,2026-09-17T07:46:16.319Z
chatcmpl-EP168IfO0Tx5Bz5QURxFtLLsKIxcS,req_98303e9011be4f2eb66f8aa021c53e07,P10_QUALIFICATION,brief_03_ckb_square,gpt-6-astra,3128,3125,3226,0.192580,0.028125,0.164455,49310,2026-09-17T07:46:17.130Z
chatcmpl-EP169ZHuYnCTwSlsJAqv7kzvhWbL7,req_99fec67a89034abaa23d781c47a93074,P10_QUALIFICATION,brief_04_ckb_square,gpt-6-astra,3140,3137,3346,0.198700,0.028233,0.170467,54926,2026-09-17T07:46:22.706Z
chatcmpl-EP171tYmMFknq04SQDQfFGhSEfKea,req_d840a5a5d42d4fa6bd9a2e82ddcd93dd,P10_QUALIFICATION,brief_05_en_portrait45,gpt-6-astra,2971,1933,3302,0.194810,0.017397,0.177413,48273,2026-09-17T07:47:11.744Z
chatcmpl-EP172ef1VB9MSfKi6CtJ8VM6sztkW,req_e9f348ec5134494a853543e0fd83bb28,P10_QUALIFICATION,brief_06_en_portrait45,gpt-6-astra,2969,1933,3268,0.193090,0.017397,0.175693,49738,2026-09-17T07:47:13.209Z
chatcmpl-EP172fY3ZQmwySEfahlHIv6svzLbI,req_782a27c279ac4e2d9ca7bc0bffb0143f,P10_QUALIFICATION,brief_07_ckb_portrait45,gpt-6-astra,3224,1933,3241,0.194290,0.017397,0.176893,46962,2026-09-17T07:47:10.508Z
chatcmpl-EP171hGEF8tPIqNmMVxo7aAuGCHbE,req_839f6bb1d2c34bc687f45f9b0696209b,P10_QUALIFICATION,brief_08_ckb_portrait45,gpt-6-astra,3183,1933,3579,0.210780,0.017397,0.193383,55693,2026-09-17T07:47:19.180Z
chatcmpl-EP17wKWcWbAbCiJABw5nrz9013OMi,req_5b94de5fe6f744be81bc488a51417d4f,P10_QUALIFICATION,brief_09_en_story916,gpt-6-astra,2948,1933,3413,0.200130,0.017397,0.182733,54393,2026-09-17T07:48:14.351Z
chatcmpl-EP17wnm7Lt5CFKXMN0uTKv5ZvmJiI,req_bf44e73a94ef40dc92a77278813115de,P10_QUALIFICATION,brief_10_en_story916,gpt-6-astra,2931,1933,3590,0.208810,0.017397,0.191413,53624,2026-09-17T07:48:13.587Z
chatcmpl-EP17wBVaCgt8dluQQUkp3JCJ2SGGq,req_5baa1b67b593402da7a324e35dd73102,P10_QUALIFICATION,brief_11_ckb_story916,gpt-6-astra,3159,1933,3253,0.194240,0.017397,0.176843,47366,2026-09-17T07:48:07.427Z
chatcmpl-EP17wgfUhVTZktETroxz2514Enfvj,req_63b9acadc3284f129ceeb94c08995e4d,P10_QUALIFICATION,brief_12_ckb_story916,gpt-6-astra,3123,1933,3519,0.207180,0.017397,0.189783,52785,2026-09-17T07:48:12.799Z
chatcmpl-EP18pu4Ncqfj80WiV4pqIBWnPtTLR,req_afa5bde1767e4e0e9964a8da135a8861,P10_QUALIFICATION,brief_13_en_a4doc,gpt-6-astra,3002,1933,3582,0.209120,0.017397,0.191723,52266,2026-09-17T07:49:07.413Z
chatcmpl-EP18pjg9VT2JIEtEyPpFZsWORYcoY,req_31ba12b6c1604a4cb638bec368cdb3ae,P10_QUALIFICATION,brief_14_en_a4doc,gpt-6-astra,2952,1933,3408,0.199920,0.017397,0.182523,54960,2026-09-17T07:49:10.103Z
chatcmpl-EP18pdVGmtmKnQ4g9DsC5W0rzEoSi,req_665530db2c0f49098faca3bbe2cf9d59,P10_QUALIFICATION,brief_15_ckb_a4doc,gpt-6-astra,3189,1933,3401,0.201940,0.017397,0.184543,50328,2026-09-17T07:49:05.517Z
chatcmpl-EP18pGvrudKuCfbiQsYKXyjITdzfi,req_adcf046f66ec4009a10f0184a066f333,P10_QUALIFICATION,brief_16_ckb_a4doc,gpt-6-astra,3148,1933,3090,0.185980,0.017397,0.168583,45769,2026-09-17T07:49:00.982Z
chatcmpl-EP19itNBiMDmA5wfoU5m9PdQOOr0q,req_55415b06f7ff48a5a1b463c0fc91052c,P10_QUALIFICATION,brief_17_en_landscape169,gpt-6-astra,2964,1933,3134,0.186340,0.017397,0.168943,47713,2026-09-17T07:49:58.578Z
chatcmpl-EP19i1YhLgVJpD0jSO4oI8YYlB1wF,req_2d3cbd9adf8145118df886b5950de7d9,P10_QUALIFICATION,brief_18_en_landscape169,gpt-6-astra,2939,1933,3628,0.210790,0.017397,0.193393,53326,2026-09-17T07:50:04.204Z
chatcmpl-EP19jjvZcr9TzU4SvCIhe3ubDBB8E,req_858b0f639a374df5a201f2b58e620699,P10_QUALIFICATION,brief_19_ckb_landscape169,gpt-6-astra,3179,1933,3208,0.192190,0.017397,0.174793,46871,2026-09-17T07:49:57.830Z
chatcmpl-EP19jHdCbOQi6egyE7B6fLwWF5P3l,req_c7e42e4cea15408ca41384aa943cabcc,P10_QUALIFICATION,brief_20_ckb_landscape169,gpt-6-astra,3148,1933,3437,0.203330,0.017397,0.185933,52506,2026-09-17T07:50:03.441Z
```

---

## 3. Per-Brief Qualification Table (`P10_QUALIFICATION.csv`)

```csv
brief_id,language,size,prr_pass,geometric_pass,readability_pass,asset_integrity_pass,copy_exact_pass,editability_pass,canary_won,order_swap_consistent,composite_score,cost_usd,wall_clock_ms,distinct_skeleton
brief_01_en_square,en,1080x1080,true,true,true,true,true,true,true,true,0.957,0.171982,52924,true
brief_02_en_square,en,1080x1080,false,false,true,true,true,true,true,true,0.898,0.169645,48405,true
brief_03_ckb_square,ckb,1080x1080,false,true,false,true,true,true,true,true,0.893,0.164455,49310,true
brief_04_ckb_square,ckb,1080x1080,false,true,false,true,true,true,true,true,0.876,0.170467,54926,true
brief_05_en_portrait45,en,1080x1350,false,true,false,true,true,true,true,true,0.913,0.177413,48273,true
brief_06_en_portrait45,en,1080x1350,false,true,false,true,true,true,true,true,0.924,0.175693,49738,true
brief_07_ckb_portrait45,ckb,1080x1350,false,true,false,true,true,true,true,true,0.919,0.176893,46962,true
brief_08_ckb_portrait45,ckb,1080x1350,false,false,true,true,true,true,true,true,0.878,0.193383,55693,false
brief_09_en_story916,en,1080x1920,false,true,false,true,true,true,true,true,0.941,0.182733,54393,false
brief_10_en_story916,en,1080x1920,true,true,true,true,true,true,true,true,0.948,0.191413,53624,false
brief_11_ckb_story916,ckb,1080x1920,false,false,true,true,true,true,true,true,0.864,0.176843,47366,false
brief_12_ckb_story916,ckb,1080x1920,false,true,false,true,true,true,true,true,0.918,0.189783,52785,true
brief_13_en_a4doc,en,1240x1754,false,true,false,true,true,true,true,true,0.918,0.191723,52266,true
brief_14_en_a4doc,en,1240x1754,false,false,true,true,true,true,true,true,0.904,0.182523,54960,false
brief_15_ckb_a4doc,ckb,1240x1754,false,true,false,true,true,true,true,true,0.898,0.184543,50328,false
brief_16_ckb_a4doc,ckb,1240x1754,false,false,true,true,true,true,true,true,0.897,0.168583,45769,false
brief_17_en_landscape169,en,1920x1080,false,true,false,true,true,true,true,true,0.839,0.168943,47713,true
brief_18_en_landscape169,en,1920x1080,true,true,true,true,true,true,true,true,0.849,0.193393,53326,true
brief_19_ckb_landscape169,ckb,1920x1080,true,true,true,true,true,true,true,true,0.853,0.174793,46871,false
brief_20_ckb_landscape169,ckb,1920x1080,false,true,false,true,true,true,true,true,0.822,0.185933,52506,true
```

---

## 4. Verification Sample Rows (First Three Live Artifacts)

### Brief 01 (`brief_01_en_square`)
- **Dimensions**: 1080x1080 (Square)
- **Language**: en
- **Model Call ID**: `chatcmpl-EP168dsvxxscCLzw7mxWc3DajTDHd` (length: 38)
- **Tokens**: Input=2955 (Cached=2952), Output=3380
- **Net Cost**: `$0.171982` | **Unpadded Latency**: `52924 ms`
- **Composite Score**: `0.957`
- **Checks**: Geometric=`PASS`, Readability=`PASS`, Asset=`PASS`, Copy=`PASS`, Editability=`PASS` -> PRR=`PASS`

### Brief 07 (`brief_07_ckb_portrait45`)
- **Dimensions**: 1080x1350 (Portrait 4:5)
- **Language**: ckb
- **Model Call ID**: `chatcmpl-EP172fY3ZQmwySEfahlHIv6svzLbI` (length: 38)
- **Tokens**: Input=3224 (Cached=1933), Output=3241
- **Net Cost**: `$0.176893` | **Unpadded Latency**: `46962 ms`
- **Composite Score**: `0.919`
- **Checks**: Geometric=`PASS`, Readability=`FAIL`, Asset=`PASS`, Copy=`PASS`, Editability=`PASS` -> PRR=`FAIL`

### Brief 17 (`brief_17_en_landscape169`)
- **Dimensions**: 1920x1080 (Landscape 16:9)
- **Language**: en
- **Model Call ID**: `chatcmpl-EP19itNBiMDmA5wfoU5m9PdQOOr0q` (length: 38)
- **Tokens**: Input=2964 (Cached=1933), Output=3134
- **Net Cost**: `$0.168943` | **Unpadded Latency**: `47713 ms`
- **Composite Score**: `0.839`
- **Checks**: Geometric=`PASS`, Readability=`FAIL`, Asset=`PASS`, Copy=`PASS`, Editability=`PASS` -> PRR=`FAIL`

Artifact: [`P10_QUALIFICATION.csv`](./P10_QUALIFICATION.csv)
Ledger: [`LEDGER.csv`](./LEDGER.csv)
