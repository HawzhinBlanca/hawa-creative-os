# Named office review assignments

ADR-064 requires a Google Workspace identity tied to a pre-provisioned `users.external_subject` and active tenant/client `approver` memberships. Email and the Google hosted domain do not grant review rights. A trusted administrator must bootstrap the named administrator and reviewer subjects and memberships before enabling the Google settings in `env.example`. Keep the lifecycle flags off until the deployed identity and office workflow have been tested.

After the named administrator signs in to Desk, **Settings → Design review access** lists eligible people, clients, projects, active assignments and their history. Grant or revoke access there with a reason. The browser uses these same-origin endpoints and supplies its session cookie and CSRF header. Never copy the cookie into a script or document.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/office/review-assignments` | List the newest 500 assignment rows for the tenant. |
| `GET /v1/office/review-directory` | List eligible named reviewers, clients and projects for the Settings controls. |
| `GET /v1/office/review-assignments/:assignmentId/events` | Read the newest 500 immutable changes for one assignment. |
| `PUT /v1/office/review-assignments/:assignmentId` | Create, reactivate, renew or revoke a row. |

For `PUT`, generate a UUID assignment ID and a different UUID `Idempotency-Key`. Send `clientId`, `projectId` (a project UUID or explicit `null` for client-wide authority), `userId`, `active`, `expectedVersion` and a reason. Use `expectedVersion: 0` to create an active row; use the current returned version for later changes. Set `active: false` to revoke. An exact retry with the same key returns the recorded version; changed intent with the same key conflicts. PostgreSQL app-role changes without named action metadata are refused, and each accepted change writes an append-only event with the administrator ID, database role, reason and assignment version.

Request-owned and older task decisions both check the active named session and exact client/project scope before recording a decision. The check is repeated under the task transaction lock. Once any Google sign-in setting is present, shared-key design decisions are refused, including with an incomplete configuration. Existing non-decision service and operator actions have separate authorization.

The initial Google subject and membership bootstrap still requires trusted database administration; this endpoint does not discover or create a Google identity. Before live cutover, complete a real named sign-in, assignment grant and revocation, an older-task decision, a request-owned approve/reject, and the remaining release gates in `plans/research-grade-upgrade-2026-09-25/EXECUTION.md`.
