# R13 — Structural candidate diversity, first slice

**Date:** 2026-09-25. **Status:** in progress. **Source:** `d39313a` on `codex/research-grade-design-system`.

## Fault and change

Studio v2 previously counted distinct concept *archetype labels* as diversity. Studio v3 computed a mean text-box distance by array position but only logged a warning when two layouts were near identical; both candidates still reached the tournament. The old measure ignored reordering, logos, photos, artwork and large structural shapes. The generator's instruction to move boxes by 15 pixels was not an enforcement mechanism.

The structural screen now compares semantic copy slots, logo, photo placements and treatments, art presence/motif and sizable panel/accent/frame shapes on a size-normalized canvas. It ignores colour and model-assigned concept names as proof of composition difference. The v3 generator removes repeated candidates and keeps their metadata aligned; fewer than two distinct candidates refuse. Studio checks again after preparation, where normalization might collapse layouts. The standard v2 layout stage drops a repeated validated composition even if its concept label differs. There is no extra model call.

Focused tests exercise reordered text nodes with changed labels/colours, moved logo and photo, v3 duplicate removal, v3 one-composition refusal, and v2 same-layout concepts. **Focused verification:** 6 files / 58 tests pass; source and included tests typecheck. The first full-suite run after source commit passed 405 files / 3,056 tests, with 4 files / 48 tests skipped, and failed **one** release-manifest test because `RELEASE_MANIFEST.json` still sealed the previous source. This is a failed run, not a passing release gate. A clean-tree seal and rerun are required below.

## Admission limits

R13 is **not accepted**. This detector is a conservative geometry screen; it does not compare rendered pixels or independently measure generated image similarity. The 15-on-1000 threshold has not been calibrated on authorized designs or human duplicate labels. V3 still generates coordinates in the same model response as concept names, and there is no tested independent DesignPlan stage, strong template baseline, human uncertainty choice, or blinded comparison of task fit and preference. Dropping a candidate can reduce choice; no evidence shows it improves quality. The final study must measure near duplicates on *shipped Canva exports* and report safety, task fit and human preference with a fixed candidate budget.

**Release status:** pending reseal and fixed-tree full-suite check. Production flags remain off. No real Canva export, deployment, provider run or human study occurred in this slice.
