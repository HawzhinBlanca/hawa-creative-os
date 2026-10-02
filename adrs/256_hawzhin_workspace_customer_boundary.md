# ADR256 — Hawa inside the existing hawzhin.app Designer route

Date: 2026-10-02. Status: integration selected by owner; implementation and launch not qualified.
Requirements: FR-001, FR-006, FR-043, FR-054, FR-068, FR-069, FR-077, NFR-006.
Sources: MASTER_SPEC.md; docs/09_MESSAGING_AND_OFFICE_INBOX.md;
docs/14_SECURITY_THREAT_MODEL.md; docs/17_UI_UX.md; docs/30_CURRENT_STUDIO_CONTRACT.md;
plans/hawzhin-app-integration-2026-10-02/PLAN.md.

## Evidence and direction

The owner requests the complete existing Hawa Studio in the Graphic Design area
of hawzhin.app, with the site's existing login and self-service generation and
downloads. The actual linked project is HawzhinBlanca/hawzhinstt, pinned at
eae4dc2ae5e883f2b233cf731be76a77a1f64ba6. Its single workspace registry has
three live tools and a `designer` entry at `/designer`, status `soon`.
Its route already wraps Designer in ProtectedRoute, RequireAccess and AppLayout.
Authentication is Supabase; server membership uses `has_app_access`.

## Decision

Integrate at `/designer`, within the existing site and shared login. Reuse the
existing generation, preview, feedback and revision behavior with a customer
transport and navigation. Keep Hawa's durable engine, database, Restate journal
and content-addressed files as the source of truth. A background job runs without
the customer keeping the tab open or manually advancing Studio stages.

Authenticate the site's member at Hawa's separate customer boundary against the
exact configured Supabase project and its current server membership check.
A site member identity is not an office account, client grant or operator role.
Resolve the immutable customer/client/project grant in Hawa before retrieval.
Every task, image, run, source and export must also belong to that customer.
Do not expose the existing office API through a shared operator key, publicly
forward the office proxy proof, or use trusted_office on the public listener.
Customer acceptance/download is an independent event and policy. It cannot grant
staff publishing, governed rule activation, or administrative authority.

Keep Canva as the native editor/export provider. Reuse verified editable source
generation, but qualify automatic native import and exports for the advertised
formats before opening self-service. The manually verified Canva acceptance
design does not qualify automated customer generation or an embedded editor.

Public hosting remains unresolved. Prepare an always-on Docker deployment;
select the actual host and resources with the owner before purchase or cutover.
The public ingress exposes only customer routes. Staff controls and storage,
database and Restate ports remain private. Cutover must fence duplicate workers
and pollers and restore all coordinated stores before enabling the route.

## Qualification

Track each gate in PLAN.md. No customer launch is admitted by this ADR or by
identity-verifier tests. Initial changes are isolated on
`codex/hawzhin-app-integration` in both repositories. Do not mark the registry
live or publish the new Designer screen until the complete real flow passes.
