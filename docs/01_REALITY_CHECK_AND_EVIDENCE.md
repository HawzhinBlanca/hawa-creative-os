# Reality Check and Evidence Ledger

**Research freeze:** 2026-09-03  
**Purpose:** Separate implemented capability from marketing language, architectural inference, and unverified assumptions.

## 1. Corrected conclusion

The office should not build a generic “AI marketing SaaS.” It should assemble a private creative workstation around capabilities that already exist, while owning the task state, client knowledge, editable source, quality evidence, and feedback history.

The strongest current composition is not the most popular composition:

- a custom **Hawa Desk** is canonical instead of Slack;
- **Restate** is used for execution journals rather than an automation canvas;
- **HyCanvas** is a conditional editable studio rather than a flattened template service;
- **Editable-Design** contributes a reconstruction method rather than serving as the whole application;
- **ComfyUI** is a pinned visual-asset laboratory rather than the system controller;
- **PostgreSQL** holds authoritative Client DNA and hybrid retrieval rather than outsourcing “memory” to a generic vector service;
- model roles are selected by an office benchmark, not by public popularity.

## 2. Evidence standards

Every material external claim is assigned one of four states:

| State | Meaning | Permitted architectural use |
|---|---|---|
| **Implemented and inspected** | Source path or official API proves the capability exists | May be designed against, but still needs integration tests |
| **Released and CI-backed** | A versioned release and successful automated checks exist | May enter Phase 0 proof; not automatically production-safe |
| **Documented only** | Vendor or repository documentation claims it | Must be verified before becoming a hard dependency |
| **Hypothesis** | It is an architectural inference or expected behavior | Must remain behind a gate or fallback |

A GitHub star count is not an evidence state. A polished demo is not an evidence state. “Open source” is not synonymous with maintainable, secure, or compatible.

## 3. HyCanvas evidence

### What is strongly supported

At the research freeze, HyCanvas had:

- a non-prerelease **v0.3.9** release dated 2026-08-30;
- prebuilt binaries for Linux, macOS, and Windows plus SHA-256 checksums;
- a successful CI run on 2026-09-03;
- a versioned Zod-backed `.hyc` schema with forward migrations;
- editable text, images, vectors, groups, charts, tables, rich text, fills, effects, and page/document metadata in the schema;
- server-side generation code using structured schemas, validation, bounded concurrency, and repair feedback;
- an explicit assistant-tool manifest including generation, editing, translation, charting, critique, resizing, and brand application;
- implemented bidirectional-text logic and automated tests for Arabic/Hebrew, mixed Latin, digits, alignment, and style runs;
- PostgreSQL-backed self-hosting and a single-binary deployment path documented by the project.

### What remains unproven for this office

- Sorani-specific shaping, punctuation, numerals, ligatures, line breaking, font fallback, and mixed-direction behavior in every editor/export path;
- browser/editor, PNG, SVG, PDF, and PPTX visual parity;
- the complete generation API and MCP behavior under office-specific posters rather than presentation examples;
- long-running reliability under interruptions, simultaneous edits, provider failures, and migrations;
- correctness of all roadmap or README claims;
- long-term maintenance because the project is still v0.x and newly created;
- acceptable behavior for paired brackets and Unicode isolate controls, which its bidi implementation explicitly says are not fully implemented.

Therefore HyCanvas is **the leading candidate, not an unconditional dependency**.

## 4. Editable-Design evidence

Editable-Design contributes an unusually strong method:

1. generate a private art-direction reference;
2. never ship the reference pixels;
3. decompose the visual direction into independently generated or code-native assets;
4. set every factual string as real text;
5. build semantic editable layers;
6. render, observe, repair, validate, and retain a replayable record.

Its Apache-2.0 code and supplied validation scripts make it useful as reference implementation material. It is not a complete office platform: it does not replace task intake, permissions, tenant isolation, workflow durability, office knowledge, publication, collaborative operations, or long-term source management.

## 5. Repositories rejected as the primary studio

| Repository | Valuable idea | Why it is not the production core |
|---|---|---|
| **Artboard** | Clean, diffable JSON; one deterministic SVG scene path; command inversion | Explicitly early v0.1; editor and template library incomplete; limited text/features |
| **Tela** | Excellent direct-manipulation UI, local-first canvas, responsive formats, automation bridge | Source showcase with no roadmap commitment; localStorage-first; dual rendering paths; no office backend or durable collaboration |
| **VibePoster** | Brand RAG, layout DSL, critic loop, PSD ambition | Tiny adoption, multi-agent complexity, split Python/Node stack, and insufficient evidence of production-grade PSD/RTL behavior |
| **Shotluma** | Focused, code-oriented creative editing patterns | Useful code donor/fallback, not a sufficiently complete office platform |
| **DesignCode** | Programmatic PSD/editable-design experiments | Useful for export experiments, not a complete authoritative editor/workflow |
| **Penpot** | Mature collaborative open design platform and standards orientation | Broad product-design tool; AI graphic automation and office-specific workflows would require a larger integration surface |
| **Polotno** | Mature embeddable editor and renderer | Proprietary document/runtime dependency and per-vendor constraints; retained only as an emergency fallback candidate |

## 6. Messaging reality check

### Telegram

Telegram offers an official Bot API, stable update identifiers, webhooks with a secret token, inline interactions, files, and Mini Apps. It is a suitable office bridge, but Hawa Desk—not Telegram—owns task state.

### WhatsApp

Two paths exist and neither should own the architecture:

- Meta’s official business APIs have account, group, template, and product-policy constraints that may not match existing office groups.
- WAHA can expose existing WhatsApp sessions through HTTP and supports multiple engines, but it relies on unofficial client behavior and can break or trigger account restrictions.

The system therefore supports a dedicated WAHA account only as an optional isolated adapter with message reconciliation and a kill switch.

### Slack

Slack is technically capable, but there is no operational reason to force this office to adopt Slack merely because integrations are common. It remains an optional adapter.

## 7. Workflow reality check

Restate is selected because the office needs an execution journal, not a visual automation product. Its durable execution model can remember completed calls, timers, retries, and state across process failures. It also supports operational pause/resume/restart controls and self-hosting. A single-node deployment is appropriate for the initial office scale, provided PostgreSQL inbox/outbox protects ingress and backups/restore are tested.

It does not make side effects magically exactly-once. Google Drive, Sheets, model calls, and adapters still require application idempotency keys, content hashes, and reconciliation.

## 8. Retrieval reality check

No public benchmark proves the best retrieval model for this office’s mixture of Sorani, Arabic, English, logos, historic designs, and brand documents. The architecture therefore combines:

- authoritative structured Client DNA;
- exact identifiers and hashes;
- PostgreSQL trigram/full-text retrieval;
- multimodal embeddings;
- a reranker;
- a company-specific evaluation set.

Qwen3-VL-Embedding/Reranker 2B are initial local candidates because they are multimodal and practical. They are not declared permanent winners.

## 9. Model reality check

The September 2026 model landscape changes too quickly to bake “the best model” into architecture. Model names in this package are provisional challengers. Admission is role-specific:

- client/project routing;
- brief extraction;
- creative direction;
- image generation/editing;
- visual judging;
- retrieval embedding/reranking;
- feedback classification.

The winner of one role is not assumed to be the winner of another. The creator and judge should normally come from different model families to reduce correlated errors.

## 10. Local verification limitation

The research environment could inspect GitHub source, releases, workflow evidence, and official documentation, but could not download and execute the HyCanvas binary because external binary retrieval was blocked. This package therefore does **not** claim a local execution pass. `docs/21_HYCANVAS_PROOF_SPRINT.md` is a mandatory executable gate on the office’s own hardware.

## 11. Final evidence-based confidence

| Decision | Confidence before proof | Reason |
|---|---:|---|
| Office-owned canonical inbox | 97% | Removes platform coupling and preserves operational truth |
| Restate + PostgreSQL core | 92% | Strong fit for durable small-office operation with explicit idempotency |
| HyCanvas as first studio candidate | 80% | Unusually complete evidence, but young and RTL/export proof remains |
| Editable-Design methodology | 94% | Correctly separates art direction from editable factual output |
| ComfyUI asset worker | 90% | Flexible and reproducible when nodes/workflows are pinned and isolated |
| Provisional frontier model lineup | 65% | Must be decided by the office benchmark |
| Overall replaceability | 95% | Every material provider/editor/channel sits behind a versioned contract |
