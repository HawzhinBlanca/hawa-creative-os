# ADR-163 — Verified office proxy and restricted design worker

Date: 2026-09-30
Status: Accepted for implementation; release verification pending
Requirements: NFR-006, FR-060, FR-063, FR-066, FR-071

## Reason

ADR-146's private Host and browser headers are necessary origin checks but are
not evidence that nginx admitted a request. Another container can forge them.
Office mode also accidentally exempts cookie mutations from CSRF. The Canva
worker currently holds the ordinary operator bearer and all Core provider keys.
The owner requested implementation of the reliability repair sequence while
retaining the shared office's no-login experience.

## Decision

Require a server-only proxy proof as well as the existing office origin and
mutation checks. nginx overwrites that header in every Core proxy location.
Generate it in host-local shared configuration, never the Desk, source control,
request logs, or provider prompts. Keep it stable across releases: rotating it
on every deploy would break old worker colours and outstanding stream requests.
Rotation is coordinated by changing the host file and redeploying Core/nginx.
Fail closed if trusted office mode has no valid proof configured.

Always require CSRF for cookie-authenticated writes, including trusted office
mode. Explicit bearer requests and the credential-free verified office flow
retain their existing checks. A presented credential is always verified.

Retire the static operator bearer into a design-only credential, admitted only to the worker's exact
task-scoped design/read/outcome routes. It cannot list tasks, approve, publish,
change provider settings, or impersonate the office. The existing internal
worker token remains exclusive to /v1/internal/*. Preserve the operator user
identity for Canva connection ownership, while assigning a distinct worker actor
and auth method. Moving existing grants to a new user is a separate migration.
This route restriction does not claim that the worker's PostgreSQL access is
fully restricted: its durable outbox/poll state still uses the runtime database.

The first migration adopts the existing `HAWA_BEARER_TOKEN` value for
`HAWA_DESIGN_WORKER_TOKEN`. Core checks this principal before ordinary keys, so
that value (including a pre-existing static operator-key alias) no longer grants office/operator list or administrative access in the
new release. Keeping the value recognized by the previous Core lets its rollback
finish invocations bound to a newer worker. A brand-new random token would cause
401s throughout that rollback. The shared Desk uses verified office authority;
named operator sessions and separately issued operator keys retain their roles.
Token rotation must remain coordinated with rollback compatibility and draining
worker colours; the prepare tool refuses a mismatched legacy/design value.

Generate the worker environment from an explicit allowlist of runtime/Telegram
settings and the dedicated design token. Exclude OpenAI/Canva/administrator,
ordinary operator, office proxy and other provider credentials. Generation is
atomic and host-local; blue/green deployment keeps the old colour's environment
until it drains. No new dependency or authentication UI is introduced.

## Evidence required

Real Core tests reject forged office headers, wrong proofs, wrong origins,
cookie writes without CSRF and worker requests outside the allowlist. Both
office modes must pass the real worker-to-Core design contract. Environment
generation must exclude planted secrets and preserve token identity on repeat.
Deploy only after nginx validation, the release gate and live no-login readback.
