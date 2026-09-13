# ADR 022 — Verified Canva handoff and release evidence

Date: 2026-09-13
Status: Accepted implementation constraint under the user-authorized blocker repairs
Requirements: FR-011, FR-014, FR-015, FR-027–030, FR-038, FR-043–048, NFR-011, NFR-020, NFR-025

ADR 020/021 retain Canva as the only manual studio, PostgreSQL as operational truth and immutable captured bytes as the approval boundary. Their admission claims are not executable proof; the September 13 independent shipping report rejects qualification.

A local registry is not Canva Cloud. Remove default client design IDs and successful simulated create/apply/render/source/round-trip responses from the production adapter. Manual handoff stores an explicit per-task binding in PostgreSQL, derived from the authenticated task scope. A design cannot belong to multiple tasks or tenants. A bound URL proves a handoff address only; native editability, capture completeness and saved content remain separate checks. Missing automation or export capability returns an actionable failure, never a synthetic source hash.

Captures serialize version changes and inserts in one database transaction. Exact copy is checked in both directions; the source manifest cannot authorize its own logo. Local SVG/PDF are preview tools and cannot claim Canva provenance or CMYK conversion. Live acceptance scripts cannot insert passing QA or self-issue human approval. Release status reports unverified gates until actual scoped evidence is available.

No selected infrastructure is replaced. Genuine native capture, external delivery credentials, requested-model entitlement, human review and exact-build recovery remain release gates after these code repairs.
