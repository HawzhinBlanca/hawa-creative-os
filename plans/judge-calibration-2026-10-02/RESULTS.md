# Judge calibration, first paid run (ADR-274 item 6)

**Run:** 2026-10-03, branch `claude/judge-calibration` (based on `claude/hunt3-fixes` @ `87f1a981`).
**Approval:** owner, 2026-10-03, hard cap US$2.50 (recorded in `results.json` as `approval`).
**Judge:** the production poster judge, `gpt-6.1-sol` (`resolveModel('judge')`, ADR-237). The served model on every receipt was `gpt-6.1-sol`.
**Set:** `frozen-set.json`. It holds 47 pairs, and each pair is judged in both orders, so the run made 94 calls.
**Images:** the blinded panel images that the panel itself scored. They are the 33 JPEGs at 864x1080 in the session scratchpad `blind/d01.jpg ... d33.jpg`. All 33 ids and file names match `blindkey/key.json`, and every image's sha256 is in `results.json`.

## The ground truth is AI judges, not people

The "blind panel" is three Claude subagents that scored each design out of 10, blind to its source. Round 1 (2026-10-02) produced the frozen labels. Round 2 (2026-10-03) re-scored the same image bytes (matched by sha256) among 49 designs. Both rounds are in `panel-scores.json`.

So this run measures agreement between one model family (OpenAI Sol) and another (Claude). It does not measure agreement with human taste. Human votes are being collected separately. The calibration should be rerun against them when they arrive, and that rerun is free (see Cost).

The panel is also noisy against itself:
- Rounds 1 and 2 give the same three-way label (a / b / tie, tie when the means differ by less than 0.5) on 32 of the 47 pairs, a Cohen's kappa of 0.49.
- When both rounds decide a pair, they agree 25 times out of 26.
- Most of the disagreement is pairs that move between "tie" and "decided". Office posts and our posters scored within about 0.3 to 0.7 of each other.

## Results

Labels are each design's mean overall score, with a tie inside 0.5. "Decided" counts only the pairs that both the panel and the judge decided. A judge tie means the two orders disagreed, which is the production rule.

| Ground truth | Pairs | Decided agreement | Three-way agreement | Kappa |
|---|---|---|---|---|
| Round 1, the frozen labels (primary) | 47 | **17/29 = 58.6%** | 19/47 = 40.4% | **0.21** |
| Round 2 | 47 | 23/31 = 74.2% | 25/47 = 53.2% | 0.32 |
| All six panel scores averaged | 47 | 19/30 = 63.3% | 21/47 = 44.7% | 0.24 |
| Clear pairs only (the six-score means differ by 1 point or more) | 22 | 15/20 = 75.0% | 15/22 = 68.2% | 0.38 |
| *Panel round 1 vs round 2 (the ceiling)* | 47 | 25/26 = 96% | 32/47 = 68% | 0.49 |

On the primary labels the panel decided 32 pairs. Of those, the judge got 17 right, 12 wrong, and split (tied) on 3.

### By pair type (round 1 labels)

| Kind | Pairs | Decided agreement | Three-way | Kappa | Order flips |
|---|---|---|---|---|---|
| `document_page_vs_poster` (a shipped document page vs the navy poster for the same brief) | 5 | **5/5** | 5/5 | n/a (one class) | 0/5 |
| `ours_vs_office` (one of our renders vs a published office post) | 42 | **12/24 = 50%** | 14/42 = 33% | 0.15 | 5/42 |

### Position bias and ties

- **Verdict flips with order:** 5 of 47 pairs (10.6%). All 5 are `ours_vs_office` pairs (11.9% of them). Position consistency is 89.4%.
- **Design shown first wins:** 44 of 94 calls (46.8%), which is close to 0.5. There is no first-position bias. If anything there is a slight lean toward the second position.
- **Ties:**
  - The judge tied (split across orders) on 5 of 47 pairs.
  - The panel tied on 15 of 47 in round 1 (13 in round 2, 14 across all six).
  - The two sets of ties overlap on only 2 pairs (d10 vs d30 and d12 vs d02).
  - On 13 panel ties the judge still decided, and it chose our render in all 13.

### The main error is systematic: type-led renders beat photo posts

On the 42 `ours_vs_office` pairs:
- The judge's consistent verdict favoured our render 31 times, the office post 6 times, and tied 5 times. Across the 84 single calls, our render won 67 (80%).
- The panel's round 1 labels went the other way: office 21, ours 6, tie 15 (all six scores: office 20, ours 8, tie 14).

The dimension votes show where the lean comes from. These are the 84 calls on `ours_vs_office` pairs:

| Judge dimension | Calls won by our render | Agreement with the panel's matching dimension (all pairs, panel gap 0.5 or more) |
|---|---|---|
| legibility | 79/84 | (the panel has no such dimension) |
| typographic_craft | 75/84 | 57/72 = 79% (vs `typography`) |
| hierarchy | 58/84 | 65/80 = 81% |
| brand_fit | 47/84 | 50/78 = 64% (vs `brand_polish`) |
| composition | **20/84** (the office post won 64) | 54/66 = 82% |

Each dimension, taken alone, agrees with the panel's matching score about 80% of the time, except brand fit at 64%. The verdict still goes wrong because of how the votes are counted:
- The typographic judge counts five equal votes, and three of them (legibility, typographic craft, hierarchy) are about text.
- The judge has no imagery or impact dimension. The panel's imagery score separates the groups most (office 5.3 vs our posters 3.0), and impact is part of the panel's overall.
- So a clean type-led render outvotes a photo post 3-2, or 4-1, even when the judge itself prefers the photo post's composition.

Two other things may also push the judge toward our renders:
- KAAE's client profile ("generous space ... restrained use of its navy and gold"), already flagged in ADR-274 section 5;
- the guideline fidelity rule, which our renders follow and the office posts do not.

The judge was right where the difference was gross:
- It chose our render over the broken office post d08 (`KAAE_Standards_Higher_Ed_1080x1350.png`, panel 1.7) in 4 of 4 pairs.
- It chose the poster over the shipped document page in 5 of 5 pairs.

## Cost

| | Calls | USD |
|---|---|---|
| Smoke run (`--limit 1`, the first pair) | 2 | 0.0211 |
| Full run (that first pair came from the cache) | 92 paid + 2 cached | 0.9979 |
| **Total spent** | **94** | **1.0190** |
| Replay of the whole set from the cache (verified) | 0 paid + 94 cached | 0.0000 |

- **Per call:** $0.0108 on average, $0.0124 at most, about 3,075 input tokens. This is below ADR-237's $0.0143-0.0198 estimate, probably because these images are 864 px wide JPEGs rather than 1080 px PNGs.
- **Cost basis:** provider usage on every receipt (`costBasis: usage`). Reasoning tokens totalled 2,997.
- **Cap:** the run stayed $1.48 under the US$2.50 cap. It never came close to the harness's stop.

## Recommendation

**(a) Trusting the judge for selection: yes for coarse decisions, no for close ones.**
- It reliably throws out a clearly worse design: the document page vs the poster 5/5, the broken office post 4/4, and 75% decided agreement on pairs a full panel point apart.
- It has no order bias worth correcting: 46.8% first-shown wins and 10.6% flips.
- Between designs the panel rates as peers, it is at chance: 50% decided agreement and kappa 0.15 on `ours_vs_office`.
- Its five equal votes are tilted toward type-led designs against photographic ones.

So:
1. Keep the judge's job as rejecting the weak candidate and ordering candidates of the same kind. ADR-274's round robin among three typographic posters is that case. Do not read its pick between near-equal candidates as a quality signal. Keep `humanChoiceRecommended` on ties, and consider asking for a person when the round robin's leaders differ by one win or less.
2. Do not let the typographic five-dimension judge decide between a photo recipe and a text-only poster. Its vote count structurally favours the text-only design. This run did not measure the photo-brief judge (six dimensions including `art_direction`), which production uses when a layout places a photo. Measure that judge before trusting it for photo-vs-type selection.
3. The cheapest fix to test is a vote that weights impact and imagery (or composition) above legibility and typographic craft for poster clients. A second fix to test is removing "generous space ... restrained" from KAAE's profile; that text is the owner's. Rescore either from this cache before shipping it: only changed prompts are paid for.
4. Treat all of this as provisional until the human votes arrive. Against the AI panel's round 2 the judge scores 74% decided and kappa 0.32. Against round 1 it scores 59% and 0.21. The label noise is as large as the effect being measured.

**(b) `HAWA_JUDGE_OFFICE_REFERENCE`: leave it off for now.**
- This run tested the judge without the reference, as ADR-274 asked: one change at a time. It therefore says nothing directly about the reference.
- The failure it found suggests the reference might help. The judge undervalues office-style photo posts, and the reference shows it one. But an office post shown as "the standard" could equally just add a third image's cost (about $0.003 a call) without changing a vote count dominated by three text dimensions.
- The test to run next is the same set with `--office-reference`. It costs about $1.0-1.3 at the measured rate, which fits the $1.48 left under today's cap, but it needs the owner's go.
- The harness's reference image is `photo11_peer_evaluators_call_en.jpg`, which is d11 in the frozen set. The 2 pairs that include d11 should be excluded or reported separately.
- Turn the reference on only if it raises `ours_vs_office` decided agreement clearly above 50% without lowering `document_page_vs_poster` below 5/5.

## How this run differs from production

1. **No legibility facts.** An office post has no layout, so the facts block says none are available, for both images.
2. **The images.** They are the panel's blinded 864x1080 JPEGs, so the judge saw exactly what the panel saw. Production sends 1080-wide PNGs.
3. **The typographic five-dimension schema** (`photoBrief: false`), whatever the image. Production uses the photo schema when a layout places photographs. Production never judges an office post at all.
4. **No request brief.** Production passes the requester's instructions and copy (`judgeRequestSection`).

## Files

| File | What it is |
|---|---|
| `results.json` | The full report: plan, approval, per-pair verdicts, per-call votes, rationales and receipts (response ids, tokens, cost), image sha256s and the summary. It holds no request bodies and no secrets. |
| `call-cache.json` | Verdict and receipt per call, keyed by the sha256 of the exact request. It makes a rerun on the same images and prompt free. |
| `panel-scores.json` | Every panel judge's per-dimension scores, both rounds, with image sha256s. |
| `analysis.json`, `analyze.py` | The tables above, recomputed free from `results.json` and `panel-scores.json`. |

The harness, `scripts/experiments/judge-calibration.ts`, gained the following in this run:
- the per-call cache (`--cache`);
- a spend cap (`--max-usd`, default 2.50), with a stop before any call that could pass it;
- a stop at the first failed call, with the partial report written;
- a report rewritten after every pair;
- an image check before any call;
- key redaction in the stop message;
- tests in `packages/creative/test/judge-calibration-harness.test.ts`.

**Rerun** (free when the cache hits; any miss is paid and capped):

```
HAWA_JUDGE_CALIBRATION_APPROVED="<approval>" OPENAI_API_KEY=... \
  npx tsx scripts/experiments/judge-calibration.ts --images <dir with d01.jpg ... d33.jpg> --execute \
  --out plans/judge-calibration-2026-10-02/results.json
python3 plans/judge-calibration-2026-10-02/analyze.py
```
