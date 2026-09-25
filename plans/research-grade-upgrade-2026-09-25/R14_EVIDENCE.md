# R14 — Generated-art safety and truthful provenance, first slice

**Date:** 2026-09-25. **Status:** in progress. **Source:** `39a6cd3` on `codex/research-grade-design-system`.

## Reproduced failure and repair

The image provider returned generated pixels when its visual safety check errored. The catch left a default `{ passed: true }` value, so a 503 from the verifier could qualify an unchecked image. A red test supplied a valid generated PNG and a 503 vision response; the old code returned `provider: openai` and `verificationReport.passed: true`. The provider now stops after that billed image and returns a procedural motif. It records `fallbackReason: vision_check_unavailable`, the actual attempt count and the accrued image cost, without paying for a second image during the verifier outage.

The Studio art stage previously recorded any successful `generateArt` return as `source: generated`, even if the provider had returned the procedural fallback. It now records the provider's actual source and fallback reason, checks the returned image bytes against the receipt SHA-256, and shows “procedural fallback” in the requester status note. A red Studio test demonstrated the former false `generated` label. An art prompt containing the client name, exact approved copy, copy acronyms, numerals, or official-mark terms now refuses before the image provider is called. The protection applies to model-written prompts at the stage boundary; it cannot prove the absence of all possible paraphrases or visual marks in an image.

**Focused verification:** 3 files / 39 tests passed after the final prompt cases; the provider plus Studio focus earlier passed 4 files / 46 tests. Source and included tests typecheck. The red verifier test and red Studio provenance/prompt tests were retained in the tool run evidence before the fixes.

The committed source `39a6cd3`, evidence `2eec154` and source-candidate seal `777574f` passed the clean-tree full suite: **406 files / 3,061 tests passed, 4 files / 48 tests skipped**. TypeScript passed, blueprint validation reported **735 pass / 0 warning / 0 failure**, and the release manifest verified. The seal identifies a source candidate, not a built or deployed image.

## Admission limits

R14 is **not accepted**. This slice prevents one unchecked-image release path and protects obvious factual/brand strings before image egress. It does not establish exact-copy, official-asset and language preservation through every candidate, revision, Canva export and final QA. The visual verifier itself is a model and has no calibrated sensitivity or native-script review. The prompt guard is deliberately conservative and can false-block safe phrases; its recall against adversarial paraphrases is unmeasured. No real provider, second-client artwork, live Canva export or blinded human review was run. Production flags remain off.

**Release status:** source candidate sealed and fixed-tree checks passed. No production rollout occurred.
