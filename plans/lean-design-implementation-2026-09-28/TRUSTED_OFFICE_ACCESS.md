# Private office access — ADR-146, 2026-09-29

Owner requirement: remove authentication until customer publication; approximately five trusted team members use the app internally for the first year. The private app opens directly. Authentication remains the default for an unconfigured/customer deployment.

Set in `infra/docker/.env.production`:

```
HAWA_DESK_AUTH_MODE=trusted_office
HAWA_TRUSTED_OFFICE_ORIGIN=http://127.0.0.1:8080
```

The current nginx bind is `127.0.0.1:8080`. A private LAN deployment may use an explicit private IP origin and the same `HAWA_BIND_IP` in the compose interpolation configuration. Wildcard/public binding refuses deployment in trusted-office mode. Browser requests must use the configured origin/host; browser writes require the non-secret office request header. No password or server secret is embedded in the Desk.

Every team member is the shared `Office team` administrator, actor `trusted_office_team`. Personal attribution is unavailable; existing revision/QA/explicit human-action and client-scope controls still run. Worker and webhook authentication remain credentialed. The shared identity is not a named OIDC reviewer and does not manufacture named-review authority.

Before publishing to customers, set `HAWA_DESK_AUTH_MODE=required` and redeploy. Existing shared-key/OIDC sign-in then returns; the private mode cannot be enabled for a public origin. The owner chose publication as the cutoff, so no time-based shutoff is added.

Local focused qualification: 6 files/106 passing tests. Tests cover no-key boot, shared identity, scoped idempotent creation, office-origin/form refusal, internal-worker isolation, stream tickets, private-bind refusal, required-mode restoration, and existing authentication/session/client workflows. First run had one incomplete directory fixture; corrected fixture and both logs retained. Type/build/full release and deployed/browser readback evidence will be recorded in `output/repairs/2026-09-29-trusted-office/` before completion.

Release qualification chronology: the first deployment refused a stale release manifest, which was regenerated and sealed. The full suite then reported 5,381 passing tests, two failures and 66 skips. The provider response assertion needed the explicit `trustedOffice: false` field, and required-mode administrator routes needed their existing explicit credential requirement retained. Both were corrected; the first result remains in `full-suite-first.log`. Final deployment and fresh browser evidence supersede these intermediate attempts only after they pass; see `DEPLOYED_PROOF.json` in the evidence directory.
