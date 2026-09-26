# ADR 064: Named office identity and scoped review authority

**Date:** 2026-09-26
**Status:** Accepted for implementation
**Requirements:** FR-043, FR-044, NFR-015; R08
**Sources:** `MASTER_SPEC.md` §4, `AI_BUILD_PROMPT.md` Security requirements, `docs/12_HUMAN_REVIEW.md` §4, `docs/14_SECURITY_THREAT_MODEL.md` §§4–5, `plans/traceability.csv` FR-043; [Google OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect) (accessed 2026-09-26).

## Context

The Desk currently exchanges shared office keys for bearer sessions. Both reviewer keys resolve to one seeded user ID. A role string on that session cannot prove which person acted, and the request-owned Desk route and private lifecycle projection check global role allowlists rather than an active assignment for the task's client/project. The legacy route checks a client ID supplied in an authentication object only for `client_approver`. A signed gateway message proves Core emitted it, not that the named person had current scope. These facts do not satisfy FR-043 or the named, attributable approval policy.

## Decision

1. Staff sign in with Google's server-side OpenID Connect authorization-code flow, using PKCE, state, nonce, a fixed redirect URI and a configured hosted-domain allowlist. Core verifies the ID token's signature, issuer, audience, expiry, nonce, hosted-domain claim and verified email. Google's stable `sub` is the identity key; email is display/contact data only.
2. Core accepts only a pre-provisioned, enabled `users.external_subject` with an active tenant membership. Sign-in never creates a user or grants a role from email/domain alone. Role changes and account disabling are checked from PostgreSQL on privileged actions, including after a session was issued.
3. The browser receives an opaque, short-lived, server-stored session in a `Secure`, `HttpOnly`, `SameSite` cookie. State-changing browser requests require a separate CSRF proof. Core revokes the session on sign-out. The existing shared-key sessions remain for bounded operator/service compatibility, but they cannot approve or reject a design. A break-glass path requires a distinct named, audited mechanism; a shared administrator key is not a reviewer identity.
4. A design review requires an active `approver` membership for the task's client and, where a project is set, an active assignment to that project or an explicit client-wide assignment. Named/staged review policy may narrow this further through the review request. No global role, request body, message sender, or shared key widens the scope. Authorization is checked before the Desk gateway call and again under the Core decision transaction lock; a revocation between checks refuses the commit.
5. The append-only decision records the verified user ID, identity method, matched assignment/policy version, task client/project, exact revision and QC/export proof. Exact action-key replay may return the existing result to the same authenticated person, but a fresh or changed decision needs current authority. A private worker event cannot assert authority solely through its actor fields.

## Rollout and proof

The OIDC path and authorization policy are added behind an explicit deployment configuration; an incomplete configuration fails closed. Before production cutover, test the browser code flow against a controlled issuer; rejected issuer/audience/nonce/domain/signature; disabled, unprovisioned and revoked users; cross-client/project and stale-stage decisions; and a revocation race at the transaction boundary. Run an authorized real Google Workspace sign-in and named reviewer approval/rejection on the deployed stack. Keep the lifecycle rollout flags off until those tests, recovery drills, traceability and release gates pass.

## Consequences

Office administrators must configure the Google OAuth client, provision each reviewer by subject and assign client/project scope. Existing shared reviewer keys lose decision authority after cutover. A reviewer may retain access to non-decision operator screens only as separately authorized. The release remains unqualified until the live identity, scope and human-review evidence is collected.
