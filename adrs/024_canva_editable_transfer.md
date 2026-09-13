# ADR 024 — Structured editable transfer into Canva

Date: 2026-09-13
Status: Bounded implementation; complete design-quality admission pending
Requirements: FR-011, FR-028–032, FR-038, FR-043–048, NFR-020, NFR-025

Canva remains the sole manual editor. Connect's blank-design endpoint does not compose text. The documented binary design-import endpoint accepts PPTX with the existing design:content:write scope. A live neutral test imported three separately addressable Arial text objects and a shape; an individual text edit was possible. This is evidence for an editable transfer route, not proof that every font, vector, layout or export dimension survives conversion.

Use a pinned PPTX writer as a transport encoder for Hawa's structured design plan. Factual text is inserted verbatim by typed code; models propose layout and style, not replacement factual copy. Source content, plan, reference hashes and request hash must be durable before import. Journal the external job and resume by ID. An unknown import result must not trigger a second creation. The original source remains immutable, and Canva exports require separate comparison and approval. Do not represent imported PPTX coordinates as proof of native output dimensions.

This introduces no second editing UI or workflow framework. Unsupported operations, fonts or assets must fail with diagnostics rather than be silently flattened. Native editing remains in Canva. References: https://www.canva.dev/docs/connect/api-reference/design-imports/create-design-import-job/ and get-design-import-job/; live evidence in output/repairs/2026-09-13-finish-system/.

Live extension: an Opus 5 planned KAAE invitation transferred eight independent text blocks without wording changes, but Canva replaced Minion Variable Concept with Arimo and normalized the page size. The new source-export inspection therefore checks actual per-run fonts and exact copy (layout whitespace folded) from Canva's PPTX export. It explicitly does not certify logo pixels, transformed geometry, print quality or release. Bounded ZIP and XML readers are used only for this measured inspection need. Failed font checks remain visible and cannot imply approval. A user font upload is required before re-admitting Minion.

The existing Restate worker now uses the same authenticated Core planner/import/export checkpoints for explicitly marked new Canva requests. Historical unmarked tasks do not trigger model spending. Restate submission requires its actual invocation ID; task status and generated receipt strings are not engine evidence. Legacy deterministic studio code remains test-only with an explicit simulated adapter and is not the production path. No-op publication and messaging handlers fail rather than acknowledge nonexistent deliveries.
