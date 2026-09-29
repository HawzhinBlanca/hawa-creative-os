# ADR 146 — Trusted office access without sign-in

Date: 2026-09-29. Status: accepted by explicit owner instruction; private-office access deployed and verified in release `e04523c0`.

The owner requests no authentication during the first year of use by approximately five trusted team members, until customer publication. Repeated office-key entry blocks the current workflow. This explicitly overrides the sign-in requirement for this private deployment, not the future customer default.

Add `HAWA_DESK_AUTH_MODE=trusted_office` with one explicit `HAWA_TRUSTED_OFFICE_ORIGIN`. Only localhost/loopback/private-IP origins are accepted. Default `required` retains existing credentials/OIDC. The office HTTP authority and browser Origin must match; cross-site requests are refused. Browser writes carry a non-secret custom header to prevent cross-site forms from acting on the office. These checks are access-boundary controls, not user authentication.

The Desk starts automatically after the server confirms trusted access. No shared secret is embedded in client code. All team members act as the existing office administrator user with actor `trusted_office_team`; the UI identifies that shared actor honestly and offers no sign-out action. Individual attribution is unavailable without sign-in. Existing scoped data, workflow/QA/revision/explicit approval checks and service/webhook credentials remain in force; this mode never authenticates worker endpoints.

One-use event-stream tickets stand for the trusted-office policy and expire normally; they stop working if required mode is restored. Unknown modes or public origins refuse startup. Customer publication requires `HAWA_DESK_AUTH_MODE=required` and redeployment; there is no automatic calendar cutoff because the owner chose publication as the boundary.

Acceptance: default anonymous access denied; trusted office boot and task reads work without secrets; cross-origin/foreign host/form writes denied; internal service still requires its credential; mutations retain idempotency/client scope; UI opens Work without sign-in and displays shared office identity; restoring required mode restores sign-in. Relevant requirements: FR-006/FR-069/FR-076/FR-077, NFR-006/NFR-015. Source: owner instruction in this conversation, 2026-09-29.

Qualification: full suite 5,383 passed, zero failed, 66 skipped; all eight engineering stages passed. Live HTTP and fresh browser Work/task-entry checks passed; Core/Desk/active blue worker and private nginx binding verified. Earlier failed attempts are retained. Evidence: `output/repairs/2026-09-29-trusted-office/DEPLOYED_PROOF.json`. This qualifies the access change, not live creative quality or full customer admission.
