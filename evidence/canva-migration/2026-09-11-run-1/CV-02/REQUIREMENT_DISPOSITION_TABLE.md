# Requirement Disposition Table: Canva Migration Architecture

**Audit Date:** 2026-09-11  
**Task:** CV-02  
**Total Requirements Evaluated:** 105  
**Preserved:** 95 | **Replaced:** 5 | **Constrained:** 5 | **Unresolved:** 0  

---

## 1. Executive Disposition Summary

- **Preserved (95 Requirements):** All requirements governing multi-channel messaging ingress (Telegram, WhatsApp), client knowledge / brand DNA retrieval, workflow durability (Restate/Outbox), quality preflight, human review & approval locks, Google Drive & Sheets delivery, security boundaries, and audit logging remain 100% active and preserved in Hawa core.
- **Replaced (5 Requirements):** Embedded canvas editing adapters (Polotno / HyCanvas) and local browser canvas state managers are replaced by native Canva Studio handoff and cloud collaboration.
- **Constrained (5 Requirements):** Source portability and offline recovery requirements are reconciled with empirical reality: Canva cloud design ID is the working master; true offline recovery is guaranteed by Hawa storing canonical briefs and raw assets in PostgreSQL rather than lossy outlined SVGs.
- **Unresolved (0 Requirements):** Zero requirements are left unresolved. Every requirement has an explicit disposition, rationale, and responsible task evidence owner.

---

## 2. Complete Disposition Matrix

| ID | Name | Source Document | Disposition | Rationale | Evidence Owner |
|---|---|---|---|---|---|
| `FR-001` | Canonical task creation | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-06. | CV-06 |
| `FR-002` | Raw event retention | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-06. | CV-06 |
| `FR-003` | Webhook verification | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-06; CV-07; CV-08. | CV-06; CV-07; CV-08 |
| `FR-004` | Event idempotency | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-05; CV-06; CV-07; CV-08. | CV-05; CV-06; CV-07; CV-08 |
| `FR-005` | Task promotion | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-06; CV-08. | CV-06; CV-08 |
| `FR-006` | Manual intake | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-06; CV-17. | CV-06; CV-17 |
| `FR-007` | Client channel mapping | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-07; CV-09. | CV-07; CV-09 |
| `FR-008` | Deterministic routing first | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-09. | CV-09 |
| `FR-009` | Candidate-limited AI routing | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-09. | CV-09 |
| `FR-010` | Ambiguity gate | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-06; CV-09. | CV-06; CV-09 |
| `FR-011` | Scope lock | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-04; CV-09. | CV-04; CV-09 |
| `FR-012` | Wrong-client correction | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-06; CV-09. | CV-06; CV-09 |
| `FR-013` | Design brief schema | docs/09_MESSAGING_AND_OFFICE_INBOX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-10. | CV-10 |
| `FR-014` | No invented facts | docs/08_MEMORY_RAG_CLIENT_DNA.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-10; CV-14. | CV-10; CV-14 |
| `FR-015` | Exact-copy lock | docs/08_MEMORY_RAG_CLIENT_DNA.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-10; CV-14. | CV-10; CV-14 |
| `FR-016` | Task route selection | docs/08_MEMORY_RAG_CLIENT_DNA.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-10. | CV-10 |
| `FR-017` | Client DNA | docs/08_MEMORY_RAG_CLIENT_DNA.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-09. | CV-09 |
| `FR-018` | Knowledge ingestion | docs/08_MEMORY_RAG_CLIENT_DNA.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-09. | CV-09 |
| `FR-019` | Curated ingestion scope | docs/08_MEMORY_RAG_CLIENT_DNA.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-09. | CV-09 |
| `FR-020` | Hybrid retrieval | docs/08_MEMORY_RAG_CLIENT_DNA.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-09. | CV-09 |
| `FR-021` | Client-first retrieval filter | docs/08_MEMORY_RAG_CLIENT_DNA.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-09. | CV-09 |
| `FR-022` | Positive/negative separation | docs/08_MEMORY_RAG_CLIENT_DNA.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-09. | CV-09 |
| `FR-023` | Retrieval evidence | docs/07_MODEL_REGISTRY_AND_EVALUATION.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-09. | CV-09 |
| `FR-024` | Private composition reference | docs/07_MODEL_REGISTRY_AND_EVALUATION.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-10. | CV-10 |
| `FR-025` | Asset architecture | docs/07_MODEL_REGISTRY_AND_EVALUATION.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-10; CV-11. | CV-10; CV-11 |
| `FR-026` | Independent visual assets | docs/07_MODEL_REGISTRY_AND_EVALUATION.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-10; CV-11. | CV-10; CV-11 |
| `FR-027` | Approved logos only | docs/07_MODEL_REGISTRY_AND_EVALUATION.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-09; CV-11; CV-14. | CV-09; CV-11; CV-14 |
| `FR-028` | Editable source | docs/07_MODEL_REGISTRY_AND_EVALUATION.md | **CONSTRAINED** | Canva cloud design ID is the working master; Hawa owns canonical brief and brand assets in PostgreSQL. Outlined SVG is an export artifact, not an editable backup. | CV-02, CV-11, CV-19 |
| `FR-029` | Canonical creative document | docs/05_CREATIVE_ENGINE.md | **CONSTRAINED** | Creative document is bound between Canva design ID and Hawa structured brief; domain logic remains decoupled from proprietary canvas nodes. | CV-02, CV-04, CV-11, CV-19 |
| `FR-030` | Studio adapter | docs/05_CREATIVE_ENGINE.md | **REPLACED** | Embedded Polotno/HyCanvas studio adapter replaced by native Canva Studio binding and deep-link handoff. | CV-02, CV-04, CV-11, CV-23 |
| `FR-031` | Local edit preservation | docs/05_CREATIVE_ENGINE.md | **REPLACED** | Local canvas edit preservation replaced by native Canva cloud versioning and Hawa snapshot ingest. | CV-11, CV-12 |
| `FR-032` | Design versioning | docs/05_CREATIVE_ENGINE.md | **REPLACED** | Client-side IndexedDB canvas history replaced by Hawa task artifact versions and Canva internal history. | CV-04, CV-11, CV-12, CV-13, CV-19 |
| `FR-033` | Multi-format variants | docs/05_CREATIVE_ENGINE.md | **REPLACED** | Client-side multi-format artboard layout generation replaced by Canva native resizing, templates, and multi-page layouts. | CV-11, CV-12, CV-13 |
| `FR-034` | Sorani support | docs/05_CREATIVE_ENGINE.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-12; CV-14. | CV-12; CV-14 |
| `FR-035` | Arabic support | docs/05_CREATIVE_ENGINE.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-12; CV-14. | CV-12; CV-14 |
| `FR-036` | Language metadata | docs/05_CREATIVE_ENGINE.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-12; CV-14. | CV-12; CV-14 |
| `FR-037` | Font management | docs/05_CREATIVE_ENGINE.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-09; CV-11; CV-12; CV-14. | CV-09; CV-11; CV-12; CV-14 |
| `FR-038` | Deterministic render QA | docs/05_CREATIVE_ENGINE.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-13; CV-14. | CV-13; CV-14 |
| `FR-039` | Visual QA | docs/11_QA_RTL_MULTILINGUAL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-14. | CV-14 |
| `FR-040` | Bounded repair | docs/11_QA_RTL_MULTILINGUAL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-10; CV-14. | CV-10; CV-14 |
| `FR-041` | Human review | docs/11_QA_RTL_MULTILINGUAL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-07; CV-12; CV-15. | CV-07; CV-12; CV-15 |
| `FR-042` | Structured revision | docs/11_QA_RTL_MULTILINGUAL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-12; CV-15. | CV-12; CV-15 |
| `FR-043` | Approval authority | docs/11_QA_RTL_MULTILINGUAL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-07; CV-15. | CV-07; CV-15 |
| `FR-044` | Approval immutability | docs/11_QA_RTL_MULTILINGUAL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-04; CV-15. | CV-04; CV-15 |
| `FR-045` | Publication package | docs/13_GOOGLE_DRIVE_SHEETS.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-13. | CV-13 |
| `FR-046` | Deterministic Drive destination | docs/13_GOOGLE_DRIVE_SHEETS.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-16. | CV-16 |
| `FR-047` | Idempotent Drive upload | docs/13_GOOGLE_DRIVE_SHEETS.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-16. | CV-16 |
| `FR-048` | Publication verification | docs/13_GOOGLE_DRIVE_SHEETS.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-16. | CV-16 |
| `FR-049` | Sheets upsert | docs/13_GOOGLE_DRIVE_SHEETS.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-16. | CV-16 |
| `FR-050` | Publication reconciliation | docs/13_GOOGLE_DRIVE_SHEETS.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-16. | CV-16 |
| `FR-051` | Thread notification | docs/13_GOOGLE_DRIVE_SHEETS.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-07; CV-08; CV-16. | CV-07; CV-08; CV-16 |
| `FR-052` | Feedback ledger | docs/18_FEEDBACK_LEARNING.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-18. | CV-18 |
| `FR-053` | Rule proposals | docs/18_FEEDBACK_LEARNING.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-18. | CV-18 |
| `FR-054` | Rule governance | docs/18_FEEDBACK_LEARNING.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-18. | CV-18 |
| `FR-055` | Evaluation-case creation | docs/18_FEEDBACK_LEARNING.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-18; CV-21. | CV-18; CV-21 |
| `FR-056` | Model registry | docs/07_MODEL_REGISTRY_AND_EVALUATION.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-03; CV-10. | CV-03; CV-10 |
| `FR-057` | Model admission | docs/07_MODEL_REGISTRY_AND_EVALUATION.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-03; CV-10; CV-21. | CV-03; CV-10; CV-21 |
| `FR-058` | Model fallback | docs/07_MODEL_REGISTRY_AND_EVALUATION.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-03; CV-10. | CV-03; CV-10 |
| `FR-059` | Provider outage handling | docs/07_MODEL_REGISTRY_AND_EVALUATION.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-03; CV-10; CV-20. | CV-03; CV-10; CV-20 |
| `FR-060` | Workflow recovery | docs/10_WORKFLOW_RELIABILITY.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-05; CV-20; CV-22. | CV-05; CV-20; CV-22 |
| `FR-061` | Manual workflow control | docs/10_WORKFLOW_RELIABILITY.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-05; CV-20. | CV-05; CV-20 |
| `FR-062` | Capacity control | docs/10_WORKFLOW_RELIABILITY.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-05; CV-10. | CV-05; CV-10 |
| `FR-063` | Operational inbox | docs/10_WORKFLOW_RELIABILITY.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-17. | CV-17 |
| `FR-064` | Operations evidence | docs/10_WORKFLOW_RELIABILITY.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-01; CV-17; CV-20; CV-23; CV-24. | CV-01; CV-17; CV-20; CV-23; CV-24 |
| `FR-065` | AI tracing | docs/10_WORKFLOW_RELIABILITY.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-20. | CV-20 |
| `FR-066` | Data minimization | docs/14_SECURITY_THREAT_MODEL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-06; CV-09; CV-18; CV-20. | CV-06; CV-09; CV-18; CV-20 |
| `FR-067` | Local-only policy | docs/14_SECURITY_THREAT_MODEL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-09; CV-18; CV-20. | CV-09; CV-18; CV-20 |
| `FR-068` | Prompt-injection boundary | docs/14_SECURITY_THREAT_MODEL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-06; CV-20. | CV-06; CV-20 |
| `FR-069` | Audit trail | docs/14_SECURITY_THREAT_MODEL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-01; CV-15; CV-20; CV-24. | CV-01; CV-15; CV-20; CV-24 |
| `FR-070` | Backup and restore | docs/14_SECURITY_THREAT_MODEL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-01; CV-19; CV-20; CV-22; CV-24. | CV-01; CV-19; CV-20; CV-22; CV-24 |
| `FR-071` | Adapter health | docs/14_SECURITY_THREAT_MODEL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-07; CV-08; CV-17; CV-20. | CV-07; CV-08; CV-17; CV-20 |
| `FR-072` | WhatsApp isolation | docs/14_SECURITY_THREAT_MODEL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-08; CV-20. | CV-08; CV-20 |
| `FR-073` | ComfyUI isolation | docs/14_SECURITY_THREAT_MODEL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-20; CV-23. | CV-20; CV-23 |
| `FR-074` | Upstream pinning | docs/14_SECURITY_THREAT_MODEL.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-03; CV-20; CV-22; CV-23; CV-24. | CV-03; CV-20; CV-22; CV-23; CV-24 |
| `FR-075` | Studio fallback export | docs/06_EDITABLE_DOCUMENT_STRATEGY.md | **CONSTRAINED** | Fallback export relies on immutable PNG and PDF Print captured in Hawa artifact store rather than local canvas serialization. | CV-02, CV-13, CV-19 |
| `FR-076` | Accessibility | docs/06_EDITABLE_DOCUMENT_STRATEGY.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-17. | CV-17 |
| `FR-077` | Search and history | docs/17_UI_UX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-17; CV-19. | CV-17; CV-19 |
| `FR-078` | Office configuration | docs/17_UI_UX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-17. | CV-17 |
| `FR-079` | Cost controls | docs/17_UI_UX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-10; CV-21. | CV-10; CV-21 |
| `FR-080` | Safe deletion | docs/17_UI_UX.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-19; CV-23. | CV-19; CV-23 |
| `NFR-001` | Reliability | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-05; CV-20; CV-21. | CV-05; CV-20; CV-21 |
| `NFR-002` | Availability | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-20. | CV-20 |
| `NFR-003` | Recovery | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-05; CV-20; CV-22. | CV-05; CV-20; CV-22 |
| `NFR-004` | Performance | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-17; CV-21. | CV-17; CV-21 |
| `NFR-005` | Scalability | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-21. | CV-21 |
| `NFR-006` | Security | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-06; CV-20. | CV-06; CV-20 |
| `NFR-007` | Privacy | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-03; CV-06; CV-18; CV-20. | CV-03; CV-06; CV-18; CV-20 |
| `NFR-008` | Editability | MASTER_SPEC.md | **REPLACED** | Embedded browser canvas editability replaced by superior native Canva professional editing experience. | CV-12, CV-21 |
| `NFR-009` | Multilingual correctness | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-12; CV-14; CV-21. | CV-12; CV-14; CV-21 |
| `NFR-010` | Portability | MASTER_SPEC.md | **CONSTRAINED** | Portability preserved via structured brief, client DNA, and original high-res assets in PostgreSQL rather than vendor-specific vector schemas. | CV-02, CV-19 |
| `NFR-011` | Observability | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-20. | CV-20 |
| `NFR-012` | Maintainability | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-23. | CV-23 |
| `NFR-013` | Upgrade safety | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-03; CV-20; CV-22. | CV-03; CV-20; CV-22 |
| `NFR-014` | Determinism | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-05; CV-14. | CV-05; CV-14 |
| `NFR-015` | Auditability | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-01; CV-24. | CV-01; CV-24 |
| `NFR-016` | Usability | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-12; CV-17; CV-21. | CV-12; CV-17; CV-21 |
| `NFR-017` | Failure clarity | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-20. | CV-20 |
| `NFR-018` | Cost efficiency | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-10; CV-21; CV-23. | CV-10; CV-21; CV-23 |
| `NFR-019` | Vendor independence | MASTER_SPEC.md | **CONSTRAINED** | Vendor independence maintained by strict provider boundary adapter; studio can be switched without breaking ingress, workflow, or delivery. | CV-02, CV-19 |
| `NFR-020` | Data integrity | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-04; CV-13; CV-20; CV-22. | CV-04; CV-13; CV-20; CV-22 |
| `NFR-021` | Accessibility | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-17; CV-21. | CV-17; CV-21 |
| `NFR-022` | Internationalization | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-17; CV-21. | CV-17; CV-21 |
| `NFR-023` | Deployment simplicity | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-23. | CV-23 |
| `NFR-024` | Testability | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-20; CV-21; CV-24. | CV-20; CV-21; CV-24 |
| `NFR-025` | Evidence discipline | MASTER_SPEC.md | **PRESERVED** | Fully preserved in Hawa core architecture without dilution; implemented across tasks CV-21; CV-24. | CV-21; CV-24 |
