# ADR-285: Office Boundaries After Bug Hunt 3: Who May Write, What Is Verified, How Much Core Reads

**Date:** 2026-10-03
**Status:** Implemented on branch `claude/followup-fixes` (from `claude/hunt3-fixes` 87f1a981); not deployed.
**Requirements:** FR-003 (adapters authenticate events before persistence), FR-017 (versioned authoritative client DNA), NFR-006 (least privilege, protected admin interfaces), FR-047 (retries reuse rather than duplicate).
**Changes a foundation:** no. No migration, no new dependency, no new paid call.
**Builds on:** ADR-146 (trusted-office access), ADR-165 (provider credentials are deployment-only), ADR-239 (DNA saves keep consent), ADR-280 (office photo library), ADR-259 (customer web requests).

**Number:** 285. Checked free across every branch and worktree on 2026-10-03.

## 1. Context

Bug hunt 3 found office routes that relied on row-level security alone (none without a database), a route that recorded every relayed message as verified, no limit on a request body, a cached stylesheet that could be made to carry rules of its own, and a website request that the office photo library could not tell from an office request when it had no photo. The owner authorised the fixes below; each has a test that failed first.

## 2. Decision

1. **A website request always says so** (`customer-web-lifecycle.ts`, Codex's lane). A checked web brief always carries `customerWebPhotos`, `{v:1,images:[]}` when it has no photo, so Core derives a website photo policy for it and the office library adds nothing. `orderedCustomerPhotos` accepts an empty manifest only with no stored photo. A zero-photo open journalled before this change (no manifest) still projects; a dropped manifest that lists photos is refused. `isWebsiteTask` stays as defence in depth.
2. **Client DNA writes** (`clients.routes.ts`). POST `/clients/:id/dna` and `/snapshots` need a role in `DNA_EDIT_ROLES` (administrator, operator, designer, client_dna_manager, art_director, creative_director, office_admin; trusted-office access is administrator); rollback keeps administrator, art director and creative director. All three require an integer `expectedVersion` (400 without it, compared strictly, 409 when stale) and pass it to the versioned save, rollback included. The Desk already sent it on save and snapshot; it never calls rollback.
3. **`/ingress/unified`** (`ingress.routes.ts`). No production caller (the WAHA and Telegram adapters reach the service directly). It needs administrator or operator, records the relayed message `verified:false` with method `office_api_relay` (the credential proves the relaying office, not the channel), and refuses more than 10 attachments, one over 50 MB or a total over 100 MB (413), and malformed descriptions (400).
4. **Request bodies** (`body-limit.ts`). No body over 48 MiB is read: a declared length is refused before any handler, a chunked body is counted as the handler reads it (never buffered, so routes with their own stall deadline keep it) and answered 413 `Payload Too Large` as a problem. 48 MiB sits above the largest legitimate request (two 15 MB comparison images as base64, about 40 MB); nginx still stops outside callers at 25 MB.
5. **Font stylesheet** (`fonts.routes.ts`, `font-packager.ts`). A family name outside letters, marks, digits, space, underscore, dot and hyphen (at most 64) is refused with 400 and `no-store`; the generator also reduces names to those characters and percent-encodes quote, parenthesis, backslash and whitespace in the font URL.
6. **Migration ledger and the Telegram test.** Changing the ledger needs administrator or operator; reading it also allows auditor. `GET /system/providers/test-telegram`, which calls Telegram with the bot token, needs administrator. None has a Desk caller.
7. **Outbox retire.** The reason is at most 1000 characters (422), and a database failure answers 503 without the driver's message.
8. **Desk.** Every delivery carries a digest-keyed `Idempotency-Key`, kept across a failed press (Core's legacy publish path does not read it yet). A design retry follows the task's new run instead of re-reading the failed one. The entry chunk is held to 430 kB (381 kB now): the Studio and Canva task panels, the command palette, the tour and DOMPurify load on first use.

## 3. Consequences

- An office client calling a DNA write without `expectedVersion` now gets 400; the Desk is unaffected.
- A relayed `/ingress/unified` message is no longer counted as verified anywhere it is read.
- Open: Core's legacy delivery path could honour the Desk's key; the customer manifest and its legacy-shape acceptance should be reviewed by Codex (customer lane).

## 4. Evidence

Tests: `apps/core/test/customer-requests.test.ts` (zero-photo manifest), `client-dna-write-guard.test.ts`, `ingress-unified-guard.test.ts`, `request-body-limit.test.ts`, `font-css-injection.test.ts`, `migration-and-telegram-test-roles.test.ts`, `outbox-retire.test.ts`, `hawa-work-desk-cv17.test.ts` (430 kB), `apps/desk/test/server-state.test.ts` (delivery key), `apps/desk/test/studio-retry-follows-new-run.test.ts`.
