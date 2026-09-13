# Handoff: Hawa Canva repair

The current implementation is not production-qualified. Start with [the audit](REPORT.md), then give Gemini [the full corrective task sheet](GEMINI_CORRECTIVE_TASK_SHEET.md). The new task ledger deliberately starts at NOT_STARTED. This audit did not implement the repairs.

Copy this instruction to Gemini:

> Read `/Users/hawzhin/Hawdesign/output/audits/2026-09-12-canva-reality-check/GEMINI_CORRECTIVE_TASK_SHEET.md` and its companion audit/evidence. Execute R00–R11 with honest states and the specified independent proofs. First establish one real KAAE Telegram → Astra → native Canva → Opus → manual edit/reopen → verified capture → authorized approval/delivery identity chain. Preserve existing work and data. Do not substitute a one-off render, simulated cloud adapter, generated reviewer scores, or success prose. Report actual blockers and every failed/unexecuted gate.

## Evidence

- `PROBES.json`: isolated production-source counterexamples. `probe.ts` is reproducible from the repository root with `./node_modules/.bin/tsx output/audits/2026-09-12-canva-reality-check/probe.ts`. It strips provider credentials, blocks/intercepts fetch, creates only disposable local objects, and writes only audit artifacts. It does not invoke Core, worker, database or messaging APIs. Intercepted model responses are deliberately synthetic negative controls.
- `INDEPENDENT_DECODERS.json`: Pillow/pypdf independently reject the two retained invalid files. Those fixtures must never be used as real exports.
- `RUNTIME_EVIDENCE.json`: read-only production database totals, deployed code fingerprints, and Git identity; exact commands retained.
- `SOURCE_RECHECK.json`: no audited source changed between probes and final source check; additional inspected files hashed.
- `capture-after-ax.txt` / `capture-reopened-ax.txt`: v3 capture claim followed by v2 after reload.
- `screenshots/`: exact captured UI images. Capture 04 was rejected because of screenshot stitching artifacts and was replaced by capture 08.
- `MANIFEST.json`: evidence integrity only; hashes do not certify that a claim is true.

No full monorepo suite, live paid model inference, real-client pilot, or production crash test was performed by this audit.
