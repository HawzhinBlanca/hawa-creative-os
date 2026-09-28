# Real Canva locale and paragraph-direction evidence

Capture source aefeabc; ADR-082, FR-034/035/036/041/043, NFR-020.

Two disposable designs, six actual exports, fourteen exact PPTX strings. Source language tags are rewritten by Canva; retain Hawa provenance. All per-character color runs survived. The first sheet has zero changed pixels against its prior PNG. See `offline-analysis.json` for per-block languages, directions, colors, geometry and PDF font resources. `human-review.csv` has fourteen not_reviewed rows and is never overwritten by analysis.

- `locale-v1`: https://www.canva.com/design/DAHWW0iRrsI/edit
- `locale-v2`: https://www.canva.com/design/DAHWW7M4nIw/edit

`fixtures.json` pins encoder/provider source at the capture commit. `live-capture.json` journals every import/export and metadata samples; timestamps are not an atomic revision lock. No editing transaction was opened. Native read-only tool output is lossy for paragraph breaks and does not provide native object IDs.

The initial capture-time QA files are immutable historical results. The rechecked files demonstrate the corrected paragraph parser and separate visual-review requirement. The Studio mixed block is a retained failure: font-family inference overrides explicit rtl:false before import. This is the next source repair, not a passing control.

Offline: run `analyze.py` with Pillow/pypdf, then `node --import tsx output/acceptance/2026-09-27-canva-locale/recheck_qa.mts`. Analysis checks historical source via Git. The live capture script performs real provider calls, refuses changed source recipes/uncertain replay and must not be used as an offline test.

Final acceptance: eight files/128 tests, zero skips; types/lint/Desk build pass. Red and intermediate failed test receipts are retained. See `plans/research-grade-upgrade-2026-09-25/R19_LOCALE_CANVA_PROOF.json` for commands/artifact hashes and limits. Production, real human approvals and delivery were not changed.
