# Hawa Studio in hawzhin.app

Owner scope: existing `/designer` becomes the complete browser design workspace.
Existing login; self-service generation, revisions and downloads. No Telegram
account or manually advanced pipeline is required. No new standalone product.

## Verified starting point — 2026-10-02

- Site source: `HawzhinBlanca/hawzhinstt`, commit
  `eae4dc2ae5e883f2b233cf731be76a77a1f64ba6`, connected Lovable project
  https://lovable.dev/projects/bbae9127-1cf1-402a-b1ff-6dbfc5433ccc.
- Registry: `src/lib/workspaceApps.ts`, designer `/designer`, status `soon`.
  Launcher, sidebar and switcher derive from it; update that single registry.
- Actual route: `src/App.tsx`, already ProtectedRoute → RequireAccess →
  AppLayout → Designer. Designer currently renders the coming-soon screen.
- Existing identity: `src/hooks/useAuth.ts`, Supabase auth. Membership authority:
  `supabase/functions/_shared/accessGate.ts` and `has_app_access`.
- Existing Hawa Studio is reusable, but its StudioPanel includes office recovery,
  settlement, stage advancement and cost controls. Do not copy these capabilities
  into public access. Reuse the actual preview/feedback/view behavior with a
  customer transport; operator controls remain in Desk.
- Hawa's current production is the private deployment. An always-on public
  backend and customer permissions are not yet installed. A website login alone
  does not make this backend accessible or authorize its office API.

## Execution and acceptance

| Slice | Requirements | Concrete work | Acceptance gate |
|---|---|---|---|
| Identity | NFR-006, FR-068 | Verify the exact site Auth issuer and current member gate. Persist governed mapping to a Hawa customer, not an office role. | Invalid/expired/other-issuer credentials, revoked member, dependency outage and impersonation fail closed; verified member has no admin/client rights by default. |
| Scope and budgets | FR-006, FR-017, FR-077, NFR-006 | Provision customer workspace/brand; immutable client/project grant, task owner, source/export authorization; atomic quotas, per-job spend and concurrency reservations. | Two customers cannot list, retrieve, stream, edit or download each other's jobs/photos/brand data. Concurrent duplicate submissions consume one job and one reservation. |
| Web intake | FR-001, FR-006, FR-068 | Exact text, language, output dimensions, logo, source photos, references, photo instructions; upload sniffing/quarantine/hash/provenance. | A real six-photo request keeps every original, obeys explicit use-all/count, and otherwise selects content-aware composition; original facts/logo preserved. |
| Durable generation | FR-001, FR-040, FR-060, FR-061 | Web adapter enters existing job controller/outbox/Restate, without fabricated Telegram identity. Recovery-safe progress/history and bounded retries. | Close tab, restart services and reconnect: same task, receipts, budget and result, no repeated uncertain paid call or manual Advance Stage. |
| Preview and revision | FR-029, FR-043, FR-069 | Reuse Studio preview/feedback and revision evidence; expected revision checks, independent customer acceptance event. | Real preview; exact feedback applied; stale or concurrent revisions conflict; changing a design invalidates its old acceptance/download eligibility. |
| Editable downloads | FR-029, FR-043, NFR-006 | Capture/export current native design and serve authorized content hashes; explicit export eligibility policy separate from staff delivery. | Real generated job → native import → advertised PNG/PDF/editable source; title/photo/logo/frame survive; blocked QA gives a truthful reason. Manual Canva acceptance does not count as unattended export proof. |
| Hosting and cutover | FR-070, NFR-006 | Select host, restore DB/Restate/blobs together, HTTPS narrow ingress, provider secrets server-side, private office administration, backups. | Restore/restart real stack; no exposed DB/Restate/office routes; no duplicated poller/worker, no public trusted_office identity; rollback verified. |
| Site launch | FR-076, FR-077, NFR-006 | Replace Designer screen, update single registry only after readiness; same login/shared layout, mobile/RTL flows. | Actual hawzhin.app sign-in → Designer → upload → generate → revise → download without Telegram; second-user isolation/logout/expiry, other three tools regressions, real phone/desktop checks. |

## Hosting decision pending

Asked owner whether to prepare a cloud server, use an existing server, or keep the
computer as an initial team-only host. Recommended commercial arrangement is an
always-on Linux Docker engine reached by the site's narrow authenticated customer
API. No server has been bought, new public tunnel created, DNS changed, or app
published in this task. Do not promise uptime for a sleeping/offline office computer.

## Current work and evidence

- Both repositories have local `codex/hawzhin-app-integration` branches.
- Initial identity adapter: `apps/core/src/customer/supabase-member.ts`. The
  verified member is deliberately only an identity; it is not wired into the
  office authenticator and cannot create a task or grant a role. Customer route,
  persisted mapping, permissions and end-to-end flow remain to be implemented.
- Unit controls: `apps/core/test/workspace-member.test.ts`; results recorded in
  `IDENTITY_PROOF.json` after execution. Doubled Auth/membership transport only;
  no real sign-in, customer route, production switch or live authentication claim.
- Site code is still unchanged; Designer remains coming soon until the actual
  complete customer flow is qualified. Overall status: IN PROGRESS, NOT LAUNCHED.

Sources: verified files above; ADR256; repository traceability-linked documents;
https://supabase.com/docs/reference/javascript/auth-getuser (server verification);
https://docs.lovable.dev/integrations/any-api (reachable backend and secrets);
https://docs.lovable.dev/features/custom-domain (existing domain connection).

## Customer boundary checkpoint — 2026-10-02 (ADR259)

Actual isolated DB/RLS and mounted HTTP checks: 107 passed, zero failures/skips;
741 strict test roots and Core build pass. Website intake/history, uncertainty
replay, RTL and accessibility controls: 11 passed; types and production build
pass. See `CUSTOMER_ADMISSION_PROOF.json` for original failures and corrections.
No public launch. Core always reports generation disabled while the canonical
RequestLifecycle web entry and durable requester sink are pending. The synthetic
TaskWorkflow dispatch is not production-qualified and will be replaced.

Claude's supporting response and branch now exist, including an actual official
PPTX import/export receipt and stronger picture/logo checks. His ADR257/258 are
reserved; this boundary uses ADR259. Merge current production/support before the
next deployment candidate. Hosting choice remains pending.

## ADR260 canonical website entry — 2026-10-02

Implemented locally: stable customer-owned request receipt and quota reservation;
canonical RequestLifecycle outbox submission with a real invocation receipt;
Core-owned draft reconstruction and transaction-time access recheck; owned task
projection and explicit copy locales; separate durable web message records;
selected request detail polling; a total body-read deadline; and customer access
recheck before each new paid Studio reservation. No Telegram send/read marks are
used for web messages. Office keyset regressions found by the full combined suite
were repaired without dropping customer isolation. Migration083 remains unreleased
and was corrected before its first deployment; migration084 adds the canonical
web receipt/message tables and the narrow generation gate.

Affected proof:68 lifecycle/ownership/database tests,36 timeout/ledger tests in an
overlapping follow-up,13 website tests; all pass without failures/skips.745 active
backend test roots compile. Full website previous checkpoint:837 pass; current
website and combined-source qualification in progress. Exact failed full-run and
query-plan attempts are retained in WEB_LIFECYCLE_PROOF.json.

Next required slices: ordered photo admission, current captured previews, owned
revision/seen-question/cancel actions, independent customer acceptance and safe
PNG/PPTX download; hosting gateway and real two-user/RTL/Canva/restart admission.
The application still enforces generation disabled, and the launcher remains soon.

Final admission follow-up:56 affected backend tests passed,0 failed/skipped, including actual chat intake and shared budget regressions. Website full suite:840 passed,0 failed/skipped;14 affected tests pass after correcting the nested main landmark. These counts replace the earlier checkpoint wording for their respective tested source. Full-engine/source seal and public customer journey remain open.

Private lifecycle transport correction: direct HTTP ingress is refused by actual Restate (400, private service). Signed `ChatInbox.webOpen` now verifies worker command refs, Core matches the retained command and live ownership, and the existing SDK sends to private RequestLifecycle. Isolated real Restate rehearsal passed (same genuine replay receipt, one evidence read/projection/message, tamper403).91 affected tests pass,0 failed/skipped. See ADR260 and WEB_LIFECYCLE_PROOF.json. Full-engine regression is next; public generation and launcher remain disabled.

First sealed combined full regression:8061 passed,1 failed,67 skipped. The failure was the normative route inventory missing the two intentionally added worker-only endpoints. The reviewed inventory delta is exactly those two POST routes; all22 route inventory tests pass after correction. Final full requalification pending.
