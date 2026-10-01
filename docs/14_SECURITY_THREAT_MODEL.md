# Security and Threat Model

## 1. Security goals

- prevent cross-client disclosure;
- prevent unauthorized task/rule/approval/publication changes;
- constrain prompt injection and model tools;
- protect credentials and sensitive assets;
- preserve edit/source integrity;
- keep unofficial adapters and GPU plugins from compromising the core;
- make every privileged action attributable.

## 2. Trust zones

| Zone | Trust | Examples |
|---|---|---|
| User browser | authenticated but potentially compromised | Hawa Desk |
| Core services | highest controlled trust | API, Restate workers, PostgreSQL |
| Editable studio | trusted only through scoped adapter | Canva (active; ADR-025) |
| GPU/Comfy worker | untrusted compute sandbox | custom nodes/models |
| Messaging adapters | untrusted external edge | Telegram, WAHA |
| AI providers | external processors | frontier/image APIs |
| Google | external publication/knowledge store | Drive/Sheets |

## 3. Primary threats and controls

### Cross-client retrieval or display

Controls:

- tenant/client IDs on all relevant rows;
- database RLS and application authorization;
- client scope resolved before retrieval;
- retrieval queries require client parameter;
- signed asset URLs scoped and expiring;
- adversarial leakage tests;
- no global model context containing unrelated clients.

### Prompt injection

Messages/documents/assets are data. They cannot change:

- system policy;
- identity/authorization;
- client scope;
- tool catalog;
- model/provider egress policy;
- publication destination;
- approval status;
- permanent memory.

Tools use fixed schemas and server-side authorization. Model output is never executed as shell/SQL/HTML without strict transformation/sandboxing.

### Malicious files

- MIME sniffing and allowlist;
- size/decompression limits;
- antivirus scan where appropriate;
- sandboxed parsing/rendering;
- no macros/executable archives by default;
- image/PDF normalization;
- external-link/resource blocking in renderers;
- content-addressed quarantine.

### ComfyUI/custom-node compromise

- isolated worker/network namespace;
- no core secrets;
- read-only model store where feasible;
- allowlisted/pinned/scanned nodes;
- no community node install from production UI;
- outbound deny-by-default;
- disposable worker rebuild;
- signed job requests and scoped object access.

### WAHA/session compromise

- dedicated account/device session;
- isolated host/container;
- allowlisted groups;
- minimal retention;
- kill switch;
- no authoritative approvals;
- session revocation procedure;
- anomaly alerts.

### Model/provider data leakage

- per-client egress policy;
- minimum context packs;
- redact irrelevant personal data;
- local-only route;
- vendor retention/training policy record;
- no secrets or broad Drive access in prompts;
- complete provider/model audit.

### Editable-source tampering

- immutable revision hashes;
- signed/hashed manifests;
- optimistic concurrency;
- approval tied to exact revision/QC hashes;
- post-approval changes invalidate approval;
- source/preview/export consistency check.

## 4. Authentication

**Owner override, ADR-146 (2026-09-29):** the private five-person office may explicitly enable trusted-office access without sign-in. It runs under one honestly named shared office identity, with private origin and cross-site request controls. Individual attribution requires restoring sign-in. Customer deployment defaults to authentication and must use `HAWA_DESK_AUTH_MODE=required`.

- Google Workspace OIDC for staff where available;
- restricted allowed domains/users;
- MFA enforced at identity provider;
- short session lifetime for privileged roles;
- secure, HTTP-only, SameSite cookies;
- CSRF protection;
- no credentials in browser storage;
- break-glass local admin stored offline and audited.

## 5. Authorization roles

| Role | Main rights |
|---|---|
| Requester | create/view assigned tasks; comment |
| Operator | route, retry, reconcile, manage adapters within scope |
| Designer | edit designs/assets/templates within assigned clients |
| Language reviewer | approve language layer; no infrastructure rights |
| Approver | approve assigned task classes/clients |
| Client DNA manager | propose/activate scoped rules/assets/templates |
| Model evaluator | run datasets and manage candidates, not client permissions |
| Administrator | integrations, roles, deployment configuration |
| Auditor | read-only evidence and logs |

No user gains access solely because a chat platform says they sent a message.

## 6. Secrets

- server-side secret store or encrypted configuration;
- separate credentials per adapter/provider/environment;
- routine rotation and revocation;
- never write secrets to traces, model prompts, source packages, or errors;
- secret scanning in CI;
- Active Canva integration and optional cut-out compute receive only the scoped credentials they need.

## 7. Network

- admin and office UI reachable through Tailscale/office VPN;
- Caddy TLS/reverse proxy;
- PostgreSQL not publicly exposed;
- internal service network segmentation;
- egress allowlists for core and workers;
- rate limits and request-size limits;
- secure webhook endpoints exposed only when required.

## 8. Audit

Append-only audit events include:

- login/role/permission changes;
- client routing correction;
- Client DNA/rule activation;
- model/config/prompt/workflow changes;
- editor/source revisions;
- QA overrides;
- approvals/rejections;
- publication/deletion;
- retries/replays/operator controls;
- secret/integration changes without secret values.

## 9. Retention and deletion

Per client/project define:

- raw chat retention;
- attachment retention;
- model prompt/response retention;
- source/final artifact retention;
- audit retention;
- backup expiration;
- legal holds;
- external-provider restrictions.

## 10. Security release gates

- zero cross-client access in automated tests;
- dependency/container scans reviewed;
- restore and key-rotation drills pass;
- prompt-injection suite cannot alter privileged state;
- ComfyUI/WAHA network isolation verified;
- source hashes and approval invalidation verified;
- Uploaded asset byte inspection is bounded by file size, pixel/table expansion,
  one active parse per Core and disposable decoder processes with time/output
  limits. Current client write authority precedes retention and is rechecked at
  receipt commit. Original SVG sources download as sandboxed octet-stream
  attachments; admitted bytes also retain attachment/sandbox headers. Global
  middleware must preserve route-specific CSP. Missing/corrupt sources fail closed
  even on conditional reads (ADR218).
- least-privilege Drive/Sheets access proven.

### Release identity (ADR-038, 2026-09-25)

A committed source manifest describes a candidate, not a deployed image. The deployment must reject a build stamp different from the clean checkout and inspect the built Core, Desk and Worker image IDs and OCI revision labels before traffic switches. An observed deployment receipt records those immutable IDs, the applied database migration name/hash, and effective non-secret runtime flags/models. A mutable image tag, local source checksum, or source-default model list cannot stand in for this receipt. The receipt proves those observations only; exact task/export provenance and the full release gate are still required for admission.


### Reviewed dependency repair, 2026-09-27 (ADR-095)

The source candidate pins pptxgenjs 4.0.1's image-size dependency to 2.0.4.
GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq are no longer audit exclusions; their
patch is available. Source transfer/Canva-package compatibility and an unfiltered
production dependency audit are recorded in R21_GATEWAY_SCHEMA_PROOF.json. This
is a candidate dependency change; backup/canary/rollback deployment gates remain
required before runtime rollout.


### Named daily budget administration (ADR-098, 2026-09-27)

Desk Operations exposes the existing shared office/client/role spending policy,
consistent current-day ledger usage and paginated revision history. Only a current
named administrator can append a policy after reviewing old and proposed limits
and supplying a reason. SQL checks session, tenant, actor, version and limits hash
under the same short lock as paid admissions. Runtime direct table writes remain
denied. The database records human identity separately from its connection identity;
historical owner revisions do not acquire fabricated human attribution.

Limits use nonnegative whole micro-dollars, including an explicit zero stop.
Removing a client or role override restores the displayed default. Lowering a cap
retains existing obligations; raising one never clears uncertain execution or
missing history. The fixed Asia/Baghdad day and current ledger accounting remain.
Desk retains an exact action scoped to the office and user before POST and retries
it after an uncertain answer or remount. Replay rechecks authority and returns the
original receipt before checking whether newer policy revisions exist. See
runbooks/SPENDING_POLICY.md. Other paid paths and live admission remain open.
