# ADR 023 — Canva connection and durable export retrieval

Date: 2026-09-13
Status: Implementation, live account admission pending
Requirements: FR-011, FR-028–032, FR-038, FR-043–048, FR-075, NFR-006, NFR-011, NFR-020, NFR-025

Preserve ADR020/022: Canva is the native manual editor; Hawa owns task scope, evidence and approval. A chat connector's authorization is not transferable to the running office server.

Use Canva Connect authorization-code + PKCE. Bind single-use, expiring state to the authenticated office actor and browser cookie. Encrypt tokens and verifiers at rest using a separately configured AES-256-GCM key. Persist refresh claims before provider calls; interrupted rotation requires reconnection instead of replaying an uncertain one-time refresh token. Never store credentials in browser storage or return them through the API.

Retrieve current provider editor URLs after checking the task binding. Only provider-returned HTTPS Canva links may use opaque `/api/design/` or `/d/` paths; user-supplied binding URLs still need a parseable design ID. Keep durable IDs independent of expiring URLs.

Journal export requests before calling Canva. Reuse a recorded provider job on retries; an uncertain creation without a job ID requires investigation, never a blind duplicate. Download only provider export hosts, with byte limits and no redirects/credentials. Persist validated bytes and their hashes atomically in PostgreSQL for this bounded office export path; no extra artifact service is introduced. Enforce client/task/actor scope and stale-binding checks.

Connect metadata timestamps do not provide an atomic design revision lock. Retrieved exports are evidence pending QA, not a semantic capture or approval. Native text composition, print qualification and the approved-delivery chain stay unadmitted until separately proven. Do not relabel a PNG/PDF or blank native canvas as completed intelligent design.
