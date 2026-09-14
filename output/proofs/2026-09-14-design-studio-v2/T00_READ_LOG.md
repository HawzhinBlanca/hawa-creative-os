# T00: Read and Reconcile Log

**Date:** 2026-09-14  
**Branch:** `studio-v2`  
**Task:** T00 (Read and reconcile)  
**Author:** Gemini 3.8 Flash (Implementation Agent)  

---

## 1. Ground Truth Files & SHA-256 Checksums at Read Time

The following 27 ground truth files and architectural decision records (ADRs) specified in Section 3 of `GEMINI_TASK_SHEET.md` were read in full and verified at the start of Task T00:

| SHA-256 Checksum | File Path |
|---|---|
| `29e7e5f54ee3758f99f0bcaa27677a3c16b280b976e7bb98d6878eaad6f83752` | `apps/core/src/services/canva-design-planner.ts` |
| `537903f4df552bb7d4e7e3339968d80564bc16920225637b060fc4ac78c16af4` | `packages/creative/src/editable-transfer.ts` |
| `ccaa5e2bafcadb45af2806bc45a3caef7dbacffc073a365b9e45b66499e437dd` | `apps/core/src/services/canva-connect-service.ts` |
| `09231c21b06a8849f4648081e83d5392eca80ac35729fc744bdb16a5bd6d6165` | `packages/qa/src/canva-pptx-check.ts` |
| `2e8ba1d08f63474f920732ad1335082e7980dcde3f0f3fec8bdce9b40f679f71` | `packages/qa/src/contrast.ts` |
| `f625a23ca531f5e800fa0ef9a216b2ff9ba16382f75bbd5ab4e0eee3934e0276` | `packages/qa/src/vision-rubric.ts` |
| `2dbdd071c096a413ab99a3f56d407bc2fac35a8ba6d379e1a1fe28c7e1dc95e7` | `apps/core/src/routes/canva.routes.ts` |
| `a90fb98f47c9b878afab199bd3a4f645a977283483afac672a54e693eb82a783` | `apps/worker/src/canva-draft-workflow.ts` |
| `ea34b194af93116ce629ef0941ac07054f6a54bc4fe2d7527d61beb362a961dd` | `apps/worker/src/workflow.ts` |
| `446915c4a9d5a9dadfc16327d3adb60282c4ecdd4080ab8b8cf261c93df98751` | `apps/worker/src/workflow-dispatcher.ts` |
| `295f18c0975c7b2c79a6e01bbe15f473965bd3b962d3e9b293489abab1c71834` | `apps/core/src/app.ts` |
| `c19176b3221a2c8b3c34153f93d8aca33da06f631697bc367173dbdb65e6767b` | `apps/core/src/services/chat-intake.ts` |
| `b88ca05080fc773a6ad65739c5456f1bfd483a0e66b088bfb590c1a319fcba0c` | `apps/core/src/services/canva-status-message.ts` |
| `eb88269a72aea7196e21f10db7f1fb2cfafee5c8acf8998da0b1840a89b11829` | `packages/integrations/src/telegram-bridge.ts` |
| `93de25272de5cb2f5d3cee94bd704b9896e2b473e305d8b15767f8e9224a94ba` | `packages/creative/assets/kaae-reference.json` |
| `902db6d4a44bf5dffda601598eb74b80735f52dc60f73743fc6eac82fb06ac1f` | `packages/creative/assets/fonts/fonts.conf` |
| `7de6db596d6101e36b8c72c5f18c5f339fe71e8d524d8cdd9fe25cf1e268acaf` | `packages/creative/src/operations-to-svg.ts` |
| `7c7a39e2149d1158cb224fd27fa03870de5d4c4fa9d4b57f8c8232ab54cd79ad` | `packages/creative/src/feedback-miner.ts` |
| `823a39aa3bf82a26bc94a7c0b6d9d8250ac0f12bb76bb7884be7180c7f008f02` | `packages/evals/src/runner.ts` |
| `b5cd2f301f5f275f61778479b344bb4c3ee0e428cd6b5e7e1893098a797c1dbf` | `packages/db/migrations/007_canva_design_plans.sql` |
| `353087db99a3250ccbba78a90bd54e0a6ae3037539d2b51d47e835a9c07997df` | `packages/db/src/upgrade.ts` |
| `1b8c0f5fc7d54e5ba57b19c47dfb0d4f0bb6fa791b5d3248e498be5c6cbe7473` | `packages/db/src/provision-isolated-test-db.ts` |
| `4a2b08ba391aa17ed4f8efdeb254d4a7bd47606b198faea390d90efe00c19b5f` | `adrs/024_canva_editable_transfer.md` |
| `b3a323688c0614cc3635b58d24e2927c8122e024db945448dff9c904740aa751` | `adrs/026_single_durable_canva_draft_path.md` |
| `514d04daa4c1ee0a18f6d3943d132a26d907b0a2587ded5a3dd251273a0d26ca` | `adrs/028_bounded_sorani_copy_in_canva_drafts.md` |
| `6b957db8d20aa5b5b408e7f8aae52e46bb1f2e6fe96e29e549f865b322a68296` | `adrs/029_design_studio_v2_see_judge_revise.md` |
| `4f5c71c7f4d9eaccf9613a3da51d5fc29b438323f499f92b6126b120830d6b04` | `output/plans/2026-09-14-design-studio-v2/GEMINI_TASK_SHEET.md` |

---

## 2. Architectural Reconcile: Slotting Studio v2 into `runCanvaDraft`

In `apps/worker/src/canva-draft-workflow.ts`, `runCanvaDraft` inspects `input.designStudio`, which is populated by the workflow dispatcher from `payload.designStudio` (set at core chat-intake strictly based on `process.env.DESIGN_STUDIO_V2 === 'on'`). When `input.designStudio` is enabled, the worker drives the staged studio pipeline (`canva-studio-start` followed by polling `canva-studio-resume-n` up to 150 times at 5-second intervals) until the studio run reaches status `transferred` or `degraded`, at which point it links into the existing Canva document binding and seamlessly resumes the existing verification, PNG export, and PPTX inspection stages starting from `canva-read-binding`. When `input.designStudio` is false or omitted (the default flag-off state), the workflow executes the existing single-shot planner path (`canva-create-draft` and `canva-resume-draft-n`) without changing a single step, guarantee, or status transition of the legacy path.
