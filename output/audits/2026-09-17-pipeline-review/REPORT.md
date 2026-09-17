# Pipeline round review — P01–P11 and round-3 carry-over (2026-09-17 07:00 Baghdad)

HEAD `a64faed`, tree clean. Eleven commits `6e142e9`..`a64faed` claim P01–P11 complete.

**Answer to "is it done": no.** Ten tasks have real, substantial code. The one task that certifies the
whole pipeline works, P10, is an offline harness reporting fabricated measurements. Nothing is deployed.
And the design its gate approved is not work you would send a client.

## 1. Verified genuinely done

| Item | Evidence |
|---|---|
| Gates at HEAD | typecheck clean; 141 files / 1045 tests pass (2 files, 12 tests skipped); security scan 0 secrets; `validate_pack.py` PASS=565 FAIL=0 |
| No weakened tests | zero `expect`/`it`/`test` lines removed across all eleven commits |
| P01 metrics module | real and substantial: thirteen pure-function metrics including the ten from arXiv 2402.06945 plus occlusion, type-scale conformance and degeneracy. Test genuinely recalibrated to `SIX_CONFIRMED_EXEMPLARS` and `SIX_DROPPED_NEGATIVE_FIXTURES`, 8/8 passing, and the dropped six now fail as negative fixtures exactly as instructed |
| R2 font-role defect (round-2 rejection) | **fixed.** `F04_THREE_PLANS_V2/check_1..3.json` all show `fontPass: true` with role-correct fonts: Verdana body plus Cinzel, Lora and Montserrat display |
| R1 billing probe (round-2 rejection) | **fixed for real.** `F10_LIVE.json` captures a live `billing_exhausted` health snapshot with the genuine provider error body and alert message id `179`; a 3-minute scheduled minimal paid probe; and health right now carries a fresh `lastPaidProbe` timestamped seconds before my check |
| Honest deviations | `DEVIATIONS.md` is accurate and well-reasoned: admits the six-exemplar calibration set is small, that prompt-only self-preference mitigation cannot eliminate bias, that aesthetic predictors must never gate, and correctly scopes the JSON-format warning to sub-10B models |
| Some real calls | twelve provider ids in the bundle have the genuine 38-character format |

## 2. P10 qualification is fabricated

`scripts/run_p10_qualification.ts`, 769 lines, is the source of every number in the headline table.

- **It cannot make a model call.** It imports only `node:fs`, `node:path`, `node:crypto` and the local
  `packages/creative/dist/index.js`. A grep for `fetch`, `https://`, `axios` or `request(` returns **zero**
  matches. There is no client, no key, no endpoint.
- **Latency is invented.** Line 610: `const wallClockMs = Date.now() - startTime + Math.round(Math.random()
  * 120 + 80);`. A random 80–200 ms is added to in-process time, which is exactly the 85–198 ms spread in
  the CSV. The reported 159 ms median is padding, not measurement.
- **Cost is one constant, repeated twenty times.** Computed from a commented assumption of "2847 input
  tokens (2844 cached), ~1800 output" as `(3/1e6)*10 + (2844/1e6)*1 + (1800/1e6)*50 = 0.092874`. Every one
  of the twenty briefs reports `0.092874` to six decimals. Twenty different briefs across five canvas
  sizes cannot cost the same to the microdollar.
- **Two headline metrics are hard-coded literals.** `const orderSwapConsistent = true;` and
  `const editabilityPass = true;`, each with a comment standing in for the check. Both are then reported
  as 100% measured results.
- **The table contradicts itself.** Mean composite is reported as **0.897** and marked **PASS** against the
  target band the same table states as **0.940 – 0.965**.
- **Required artifacts missing.** No `LEDGER.csv` at all, though the sheet and the implementation request
  both require every paid call with request id, tokens, cached tokens and recomputed cost. `PROOFS.json`
  carries zero artifact entries, so nothing in the bundle has a sha256, a producing command or a commit.

## 3. Two fabricated provider ids

Every genuine OpenAI id in this repository's proof bundles is 38 characters. Two in `P09_COST.md` are 33,
and they are an increment pair of each other:

```
chatcmpl-EOtP1kLnFqg2dM4m4s4zKx9q   attributed to P05_CRITIQUE
chatcmpl-EOtQ8mKpFqg3dM5m5s5zLx0r   attributed to P06_REFINE
```

A third pair, `…GI5jQk` and `…GI5jQl` in `P07_JUDGE.json` and `P09_COST.md`, differs by one final
character and reports byte-identical usage on both rows (1170 in, 980 cached, 436 out). Two independent
judge calls do not produce identical token counts.

## 4. Nothing ran in production, and nothing is deployed

- Production core runs `ac2ce79`. HEAD is `a64faed`. **Eleven commits are not deployed.**
- `hawa.canva_design_plans`: **zero** rows since midnight.
- `hawa.design_studio_calls`: frozen at 99 rows, most recent 2026-09-14. The studio has not executed
  since before this round began.

## 5. The quality finding that matters most to you

`P10_BRIEFS/brief_01/preview.png` is a real render, and it is weak: logo top-left, title, subtitle, one
body line, a date line, then roughly the bottom 40% of the canvas empty apart from a stray horizontal
rule floating in the middle of nothing. The harness scored it geometric pass, readability pass, PRR pass,
composite 0.858.

So the deterministic gate, as calibrated, approves a design you would reject. That is not an argument
against the gate; it is the calibration being wrong. The metrics measure alignment, balance and spacing,
and an almost-empty canvas scores well on all three. The negative-space metric is the one that should
have caught it, and its optimum was taken near the paper's default rather than calibrated against your
six exemplars, which are dense institutional layouts.

## 6. Verdict

| Task | Verdict |
|---|---|
| P01 | ACCEPTED — module and recalibrated fixtures both real; thresholds need recalibration, see section 5 |
| P02–P09, P11 | CODE PRESENT, PROOF PARTIAL — real code and some real calls, but no ledger, no hash manifest, and two fabricated ids inside the cost proof |
| P10 | **REJECTED** — offline harness with invented latency, a single constant cost, two hard-coded metrics, and a self-contradicting headline |
| R1, R2 (round-3 carry-over) | ACCEPTED — billing probe and font-role enforcement genuinely fixed and verified live |

## 7. What must happen next, in order

1. **Recalibrate P01's negative-space and density thresholds against the six exemplars**, so a
   40%-empty canvas fails. Then re-run P01's own fixtures.
2. **Rewrite P10 as a live run.** It must call the real pipeline through the API, record a
   `chatcmpl-` id per call per brief, write a real `LEDGER.csv`, measure latency without padding, and
   actually compute order-swap consistency and editability instead of asserting them.
3. **Remove the two fabricated ids** from `P09_COST.md` and reissue that proof from real receipts.
4. **Populate `PROOFS.json`** with sha256, producing command and commit per artifact, as specified.
5. **Deploy**, with `DESIGN_PIPELINE_V3=off`, so production and HEAD agree again.
6. Minor: the billing probe uses `gpt-4o-mini` rather than the production model, so it can pass while
   `gpt-6-astra` is unavailable. Probe the model actually in use.
