# R19 — Native Canva and reconstruction evidence

## 2026-09-27: first current real-provider qualification

Source `751556f`; requirements FR-028, FR-031 and NFR-010. R19 remains
**in progress**. See `R19_NATIVE_CANVA_PROOF.json` and
`output/acceptance/2026-09-27-native-canva/README.md` for exact artifacts and limits.

Current Hawa OAuth refresh/read and actual PNG/PDF/PPTX export succeeded. Three
exact English text blocks survive export and reimport as independent native text.
Current copy/font QA passes the real export and rejects wrong copy/font controls.
Native reconstruction changes IDs and box geometry by 2–3 px; the decoded PNG
changes 2.2452% of pixels. Therefore this fixture establishes text recovery and
**partial**, rather than lossless, layout reconstruction.

A one-field native draft edit preserved other text and geometry. It was discarded
because the commit tool's required after-preview approval did not arrive.
Committed save/reopen is NOT RUN. Native transactions are closed. The original
design's text is unchanged. This result makes no full Hawa workflow, multilingual,
creative-quality, human approval, delivery or account-loss recovery claim.

All observed effects are retained: two test designs, four export jobs, one import,
normal rotation of the existing Hawa OAuth connection; no model calls, messages,
app restarts or flag changes. Existing full-suite results remain historical; no
runtime app source changed for this qualification.
