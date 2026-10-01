# ADR-234: An Administrator Records a Client's Consent to Model Readings

**Date:** 2026-10-01
**Status:** Implemented on branch `claude/kaae-model-consent` (from production `53644d3b`); not deployed. Applying it to KAAE is a production step for the lead after deploy (section 5).
**Requirements:** FR-066 (data minimisation, subject to client egress policy), NFR-007 (per-client model-egress policy enforceable and testable), NFR-006 (protected admin interfaces, auditable authorisation), FR-054 (only authorised humans supersede Client DNA).
**Changes a foundation:** no. No migration, no new dependency, no new paid call per design. The readers' gate (`egressAllowed()`, lifecycle-voice admission) is unchanged.
**Builds on:** ADR-144 (intake router), ADR-146/163 (trusted office), ADR-164 (the shared office administrator identity), ADR-200 (office reader), ADR-232 (copy reader).
**Number:** 234, assigned by the lead.

## 1. Context

The owner decided in chat on 2026-10-01: "yes turn on model reading for KAAE".

The intake router, the office reader and the copy reader (`requester-intent-model.ts` `readOnce` / `egressAllowed`) and voice transcription (`lifecycle-voice.ts`) send a client's words to OpenAI only when both of these hold:

- `hawa.clients.model_egress_policy` admits OpenAI. The schema default, `{"mode":"evaluated_external_allowed"}`, does.
- The client's active DNA version is approved (`approved_by IS NOT NULL`, effective now), and its `privacy.modelEgressMode` is `approved_providers` or `evaluated_external_allowed` with `privacy.allowedProviders` including `openai`.

In production, KAAE's active DNA (version 1) has no `privacy` block. Whether it is approved is not visible through the API. Every DNA writer (POST `/dna`, POST `/snapshots`, POST `/dna/rollback`) saves the new version with `approved_by` NULL, and no route approves a version. So consent could be recorded only with SQL against production, which the operating rules forbid.

## 2. Decision

### 2.1 One administrator action

`POST /v1/clients/:clientId/dna/model-consent` with exactly `{ expectedVersion, mode, providers, reason }`. Any other field is a 400, so nothing else in the DNA can be named.

- **Mode.** `approved_providers` or `evaluated_external_allowed`, with providers from `openai`, `google`, `anthropic` (no repeats). Withdrawal is the same action with `providers: []`, or mode `none` / `local_only`; it is stored as `local_only` with no providers, which every reader refuses.
- **Version.** It makes version `expectedVersion + 1`. Its DNA is the active DNA with:
  - only `privacy.modelEgressMode` and `privacy.allowedProviders` set (other privacy fields, such as retention days, are kept);
  - `version` set to the new number, because readers require `dna.version` to equal the row's version;
  - the commit metadata (`__commitMessage`, `__createdBy`), which content hashes and design reads exclude.

  `updatedAt` and every design field are untouched. `content_hash` is computed the way `client-design-reference.ts` and `canva-export-policy.ts` verify it. `ClientRepository.saveDnaVersion` supersedes the previous version, with its expected-version check under `FOR UPDATE` and a per-client advisory lock.
- **Approval.** The new version's `created_by` and `approved_by` are the acting administrator's user id.
- **Audit.** In the same transaction, one append-only `hawa.audit_events` row: action `client.model_consent.granted` or `.withdrawn`, the reason, the before and after content hashes, and in `data` the privacy before and after, the previous version's approver, and the actor (user id, actor id, auth method, role). `audit_events` accepts a row with no task under its write policy. Core cannot read such a row back through RLS, so the GET below and the DNA history are what Core reports.
- **Replay.** The request names the version it changes. Sent again after it was applied, the same request finds the version it made: the active version is `expectedVersion + 1`, it was created and approved by the same user, and its DNA equals what this request makes from `expectedVersion`. The answer is 200 with `replayed: true`, and nothing is written. Any other request on a stale version is 409 `DNA_VERSION_CONFLICT`. A request for exactly what an approved active version already holds is 200 with `changed: false`.
- **Response.** 201, with `modelReading.openai` read through the real `egressAllowed()` after commit.

### 2.2 Who may act

- **Role.** `role === 'administrator'` only. Operators, art directors, reviewers and the worker (`service`) get 403.
- **A person.** The user id must be a uuid that is not a service identity (`isServiceUserId`). The actor must not be a worker, design worker, anonymous or test principal (`test_*`, `test_harness`).
- **Membership in Postgres.** Inside the transaction, `hawa.has_tenant_role(tenant, administrator)` must hold for that user. A credential claiming the role is not enough.

In production (`HAWA_DESK_AUTH_MODE=trusted_office`, origin `http://127.0.0.1:8080`, confirmed from the running core container's non-secret settings), a request from the office origin carries:

- user id `00000000-0000-4000-b000-000000000002` (36 characters; seeded with an active `administrator` membership);
- actor id `trusted_office_team`, auth method `trusted_office`, display "Office team".

This is the identity ADR-164 already accepts for the verified shared office. It is a real user row, not a service id, and it passes. The record says honestly that the office, acting at the office origin, gave the consent. The reason names the owner's decision. A Google-signed-in named administrator (ADR-146 required mode) also passes, under their own user id.

### 2.3 A read for the lead, without SQL

`GET /v1/clients/:clientId/dna/model-consent` (administrator, operator or auditor) returns:

- the active version and whether it is approved, and by whom;
- the privacy block and the commit message;
- the client's `model_egress_policy`;
- `modelReading.openai`, from the real `egressAllowed()`.

### 2.4 No migration

Migration numbers after 073 are contested across branches (ADR-200 dropped its 074 for that reason). DNA versions and `audit_events` already hold everything this needs.

## 3. The other gate: the office's shared daily allowance

A reading also needs admission in the office's shared daily allowance, role `intake_router` (migration 068 trigger, `hawa.admit_office_spending`). The requester, office and copy readers all use that role.

- **Where it is configured.** In PostgreSQL, `hawa.studio_spending_policies`, the latest revision per tenant. It is not an env var or a setting.
- **How admission works.** The reservation must fit the remaining amount in each of three buckets:
  - office (`officeUsd`);
  - the client (`clients[KAAE]`, else `clientUsd`);
  - the role (`roles.intake_router`, else `roleUsd`).

  No bucket may report `historyIncomplete`.
- **Production default.** Migration 051 sets `{"officeUsd":30,"clientUsd":30,"roleUsd":30,"clients":{},"roles":{}}`, which is $30 a day for `intake_router`.
- **Reservation size.** With the production text model (`gpt-6.1-sol`, tier production), measured reservations are $0.017 to $0.027 per reading. The copy reader refuses only above $0.05; the others above $0.50. The default admits them.
- **Production's current revision.** Not read here: no SQL against production. Verify it with `GET /v1/spending/policy`. Raising a limit needs `POST /v1/spending/policy` by a named administrator: the service requires a Google OIDC session hash, which the trusted-office identity does not have.

## 4. Consequences

- Any later DNA save through POST `/dna`, `/snapshots` or `/dna/rollback` makes an unapproved version. Model reading then closes again (fail closed) until consent is recorded once more on the new version. The GET in 2.3 shows it.
- **Superseding version 1.**
  - KAAE's Canva drafts use the packaged KAAE reference, which carries no DNA version, so they are unaffected.
  - For any other client, a draft planned against the previous version must be planned again (`CLIENT_REFERENCE_CHANGED`), as after any DNA save.
  - The export policy's human-author check passes, because `created_by` is the administrator.
- The same consent also satisfies the privacy half of voice transcription admission. Voice still needs its own admitted deployment and cost policy.

## 5. Applying it in production (lead, after deploy)

1. Read the current state:

   ```
   curl -sS http://127.0.0.1:8080/v1/clients/c1000000-0000-4000-8000-000000000002/dna/model-consent -H 'Host: 127.0.0.1:8080' -H 'Origin: http://127.0.0.1:8080' -H 'X-Hawa-Office-Request: 1'
   ```

   Expect `version` 1 and `modelReading.openai` false.
2. Record the consent, with `expectedVersion` set to the version read in step 1:

   ```
   curl -sS -X POST http://127.0.0.1:8080/v1/clients/c1000000-0000-4000-8000-000000000002/dna/model-consent -H 'Host: 127.0.0.1:8080' -H 'Origin: http://127.0.0.1:8080' -H 'X-Hawa-Office-Request: 1' -H 'Content-Type: application/json' -d '{"expectedVersion":1,"mode":"approved_providers","providers":["openai"],"reason":"Owner approved model reading for KAAE in chat on 2026-10-01"}'
   ```

   Expect 201: `version` 2, `approvedBy` `00000000-0000-4000-b000-000000000002`, `modelReading.openai` true. Sending it again is safe (200, `replayed: true`).
3. Verify:
   - repeat step 1: `approved` true and `modelReading.openai` true;
   - `GET /v1/clients/<id>/dna`: version 2, the same design fields, and the privacy block;
   - `GET /v1/spending/policy`: the `intake_router`, client and office buckets have remaining > $0.10 and `historyIncomplete` false.
4. Withdraw: the same POST with `{"expectedVersion":<current>,"mode":"none","providers":[],"reason":"..."}`.

## 6. Verification

`apps/core/test/client-model-consent.test.ts` runs against the per-file test database as `hawa_app` under RLS, through the real route, the real trusted-office identity and the real `egressAllowed()`. It covers:

- production's KAAE state (version 1, no privacy, unapproved) admits nothing;
- refusals for: no credential, operator, art director, a test administrator, a service-id administrator, an administrator with no membership, and a wrong proxy proof;
- strict body checks;
- the grant:
  - version 2 approved by `…0002`, with version 1 superseded;
  - design fields equal and the hash consistent;
  - the audit row written;
  - the gate opens, and a reading reaches the provider through the real ledger and allowance;
  - GET `/dna` shows the same design;
  - a reference planned on version 2 is current;
- replay, and conflicts;
- withdrawal, re-grant by client code, and the no-change answer.

Run against the base routes, all 6 tests fail. With the change, all 6 pass.

Full `apps/core`, `apps/worker` and `packages/integrations` run (344 files): 4154 passed, 4 skipped, and 1 failed. The failure was the Desk bundle-size check, which needs `apps/desk/dist` and a fresh worktree has none. After a Desk `vite build`, that file passes (7 of 7). `pnpm typecheck` and `pnpm lint` pass.
