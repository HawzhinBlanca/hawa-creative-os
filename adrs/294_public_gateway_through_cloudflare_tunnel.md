# ADR-294: Public Gateway Through a Cloudflare Tunnel

**Date:** 2026-10-03
**Owner:** claude
**Status:** Implemented on branch `claude/golive` (from `claude/release-3` 5f3aec67, the live release). Not deployed. No tunnel, DNS record or Cloudflare account was touched.
**Requirements:**
- NFR-006: least privilege, encrypted transport and protected admin interfaces.
- The "Hosting and cutover" slice of `plans/hawzhin-app-integration-2026-10-02/PLAN.md`: HTTPS narrow ingress, no exposed database, Restate or office routes, no public trusted_office identity, and a verified rollback.
**Changes a foundation:** no. It adds no dependency to the engine, and the office listener and its trust model are unchanged. cloudflared is a host program on the office Mac, outside the repository's runtime.
**Builds on:**
- ADR-064: named Google reviewers.
- ADR-128: /v1/internal is never proxied.
- ADR-146 and ADR-163: trusted-office access and the office proxy proof.
- ADR-158: nginx rate limits keyed per caller.
- ADR-259 to ADR-264: the customer API.

## Context

The owner decided the following:

- The website stays on Lovable at https://hawzhin.app.
- The backend stays on the office Mac. Its public HTTPS comes from a Cloudflare named tunnel, and
  hawzhin.app DNS moves to Cloudflare.
- The browser calls `https://design-api.hawzhin.app/v1/customer/*`. Core's CORS admits only
  `https://hawzhin.app` and `https://www.hawzhin.app`.
- The office Desk needs an HTTPS origin for Google sign-in, because the OIDC redirect must be https.
  It will be https://desk.hawzhin.app.

Before this ADR, nginx had one listener, published as 127.0.0.1:8080. That listener carries the office
trust model. Every request it proxies has the server-only `X-Hawa-Office-Proof`. In
`HAWA_DESK_AUTH_MODE=trusted_office`, Core treats a request with that proof, the office Host, and no
cross-site markers as the office team, with no sign-in. Routing a tunnel to that listener would have
made the office API public with administrator rights.

Two further facts shaped the design:

- **The client address.** Behind Docker Desktop's port forwarding, every caller reaches nginx from the
  bridge gateway (172.21.0.1 on the office Mac, ADR-158). Through a tunnel, every customer on the
  internet would then share one per-address bucket.
- **Path normalisation.** nginx matches locations on the decoded, dot-merged `$uri`, but `proxy_pass`
  without a URI forwards the raw `$request_uri`. A path such as `/v1/customer/%2e%2e/tasks` matches
  a `/v1/customer/` location and still reaches Core as something else.

## Decision

1. **Two new nginx servers, on their own ports.** Compose publishes them only on the host's loopback,
   whatever `HAWA_BIND_IP` is:
   - `127.0.0.1:${HAWA_CUSTOMER_GATEWAY_PORT:-8081}` → container port 8081, for design-api.hawzhin.app.
   - `127.0.0.1:${HAWA_DESK_GATEWAY_PORT:-8082}` → container port 8082, for desk.hawzhin.app.

   The office server on port 80 is not modified.

2. **Each port answers one host name.** A `default_server` on each port returns 404 for any other
   Host, the office Host `127.0.0.1:8080` included. The named server forwards `Host $host`, which can
   only be the public name. cloudflared does not override the Host (no `httpHostHeader`).

3. **The client address comes from Cloudflare, in the public servers only.** Their configuration is
   `real_ip_header CF-Connecting-IP` with `set_real_ip_from` 127.0.0.1, ::1, 172.16.0.0/12 and
   192.168.65.0/24. Those are the addresses a connection to a loopback-published port arrives from
   inside the container (the Docker gateway).

   Note that `set_real_ip_from 127.0.0.1` alone would never match. Inside the container, cloudflared's
   connections come from the gateway, not from loopback.

   With this, `api_edge`, `login_edge` and the address fallback of `api_limit` count each internet
   client separately. `X-Real-IP` and `X-Forwarded-For` are set to that address alone. A caller's own
   `X-Forwarded-For` is discarded, never appended. The office server sets no real_ip directive.

4. **The design-api server serves only the customer API.**
   - `location ^~ /v1/customer/` proxies to `core_api` with the same `api_limit` and `api_edge` limits
     as today's `/v1/`.
   - It proxies only when `$request_uri` is plain segments: `[A-Za-z0-9_-]`, with no dot, no escape
     and no empty segment. Every customer route has that shape. Anything else gets 404, so the raw
     path Core receives is always the same as the path nginx matched.
   - `= /v1/customer` returns 404, which avoids nginx's automatic 301.
   - Every other path returns 404 from nginx itself: `/`, `/v1/health`, `/api/`, `/v1/internal/`.
   - The body limit is 12 MB, for 10 MB photos plus overhead.
   - Request headers are an **allowlist** (`proxy_pass_request_headers off`): Authorization,
     Content-Type, Accept, Accept-Language, User-Agent, Origin, the two CORS request headers,
     Idempotency-Key, X-Content-SHA256, X-Photo-Filename, If-Match-Version and If-None-Match. No
     cookie, no `X-Hawa-*` and no `X-Forwarded-*` from the caller can reach Core, including any header
     added to the office later.

5. **The desk server serves the Desk and its office API, with sign-in required.**
   - It serves `/` (the Desk), `/v1/` (rate limited as today), `/v1/events/stream` (unbuffered),
     `/v1/auth/session` (sign-in limits), `= /v1/health` (the Desk's status light, per-address
     limit), `= /auth/google/callback`, and the internal `/_blobs/` that Core's X-Accel-Redirect
     uses.
   - Core serves the callback at the root, which is the registered `HAWA_GOOGLE_OIDC_REDIRECT_URI`.
     Without this location the Desk's own nginx would answer it.
   - It does not serve `/api/` (webhooks, judge links), health under other prefixes, `/v1/internal/`
     or `/studio`.
   - Headers are a denylist, because the Desk uses many. The server sets to empty: `X-Forwarded-Host`,
     `-Port`, `-Prefix` and `-Server`, `Forwarded`, `CF-Connecting-IP`, `True-Client-IP`,
     `X-Hawa-Office-Proof`, `X-Hawa-Office-Request`, `X-Hawa-Probe-Nonce`, `X-Hawa-Lifecycle-*`,
     `X-Hawa-Desk`, `X-User-Role` and `X-Enforce-Auth`.
   - All proxy headers are set at server level, and no location declares its own, so no location can
     silently drop the set. A test pins this.

6. **Neither public server includes the office proof, and both mark the request as public.** Each one
   sets `X-Hawa-Public-Gateway: customer|desk`. `permitsOfficeRequest`
   (`apps/core/src/services/office-access.ts`) returns false when that header is present with any
   value. Trusted-office access therefore cannot apply to a request that came through the tunnel, in
   either of these cases:
   - Core runs `trusted_office`. That is a misconfiguration: the runbook requires `required` before
     the Desk is public, and Core already refuses the customer API in that mode.
   - A future edit includes the proof in a public server.

   That makes three independent locks:
   - no proof;
   - a Host that is not the private origin;
   - the public-gateway header.

   The office listener never sets the header. A client that adds it to an 8080 request only denies
   itself. Trusted-office access on 127.0.0.1:8080 is unchanged.

7. **cloudflared configuration** (`infra/cloudflared/config.template.yml`):
   - `design-api.hawzhin.app`, path `^/v1/customer/`, goes to `http://127.0.0.1:8081`.
   - `desk.hawzhin.app` goes to `http://127.0.0.1:8082`.
   - Everything else gets `http_status:404`.
   - `connectTimeout` and `tlsTimeout` are 5 s, so a dead origin fails well inside the website's 25 s
     timeout. Keep-alive is 90 s. Chunked uploads stream through.
   - There is no read timeout to set: Cloudflare's edge ends a request after 100 s without a response.

8. **`infra/cloudflared/install.sh`** is idempotent and a dry run by default. A dry run makes no
   Cloudflare call. With `--apply` it:
   - creates the tunnel `hawa-office` if it is missing, or fetches its credentials;
   - renders and validates the configuration (offline `ingress validate`; the previous file is kept);
   - runs `route dns` for both names, never with `--overwrite-dns`;
   - installs the user LaunchAgent `com.hawa.cloudflared` (RunAtLoad, KeepAlive, logs in
     `~/.hawa/logs`), and restarts it only when its plist or configuration changed.

   `--stop --apply` is the rollback: it unloads the agent and keeps DNS and the tunnel.

   It is a LaunchAgent, not a system daemon, because production already depends on the logged-in
   user's Docker Desktop.

9. **`scripts/verify_public_gateway.ts`** checks the deployment from outside. All its requests are
   read-only. It checks:
   - TLS: a trusted certificate with at least 7 days left;
   - the customer session without a token gets a JSON refusal from Core;
   - CORS for hawzhin.app, on the real response and on a preflight with every header the website
     sends;
   - no CORS for evil.example, and its request is refused;
   - eleven paths that design-api must 404;
   - the Desk page loads;
   - `/v1/auth/providers` says Google is on and trusted-office is off, even with forged office
     headers;
   - three office routes with a forged proof get 401;
   - the Google callback reaches Core and not the page;
   - four paths the Desk host must 404.

   It exits 1 on any failure. `--local` runs the same checks against the loopback listeners with the
   public Host names, before the tunnel exists.

10. **The runbook** is `runbooks/GO_LIVE_WEBSITE.md`, in order: owner, lead, website, generation on,
    two-user test, rollback.

## Considered and rejected

- **Pointing the tunnel at 8080 and relying on `HAWA_DESK_AUTH_MODE=required`.** Correct only while
  the configuration is right. One mode change, for example the documented trusted_office rollback,
  would make the office API public as administrator.
- **One public port with both host names.** It works, but separate ports keep the customer server's
  allowlist and the Desk's denylist from ever sharing a location by accident. They also make
  `--local` checks and logs unambiguous.
- **An allowlist on the Desk server too.** The Desk sends headers that change with features
  (`X-Hawa-Manual-Request-*`, CSRF, `If-Match-Version`). A missed one would break the office
  silently. The denylist covers every office-trust and forwarding header Core reads.
- **Serving `/api/judge/` on the Desk host.** That would expose judge links publicly. It is a separate
  decision, so the runbook pins `HAWA_JUDGE_BASE_URL` to the office address.
- **Requiring `CF-Connecting-IP` on the public ports.** It adds nothing against a local caller, who
  can send any header, and it would break `--local` checks.

## Consequences

- Nothing becomes public until `install.sh --apply` runs after `cloudflared tunnel login`. Deploying
  this release only adds two loopback ports, and the first deploy recreates nginx once because its
  published ports change.
- After the switch to `required`, the office uses https://desk.hawzhin.app, on the Mac as well. The
  Desk on 8080 no longer opens without sign-in, and its cookie writes fail Core's CSRF origin check,
  because the browser origin is now the public Desk. Health probes and bearer-key scripts on 8080 keep
  working.
- Canva connections are stored per Hawa user, so Google-signed-in members connect Canva again from
  the public Desk, with the new `CANVA_REDIRECT_URI`.
- **Open:** there is no supported command to enrol an office Google subject (ADR-064 bootstrap). The
  customer-account administration needs a Google-signed-in named administrator, so it is blocked
  until a reviewed bootstrap exists. No ad-hoc SQL on production. *Resolved by the 2026-10-03 addendum
  below (`HAWA_GOOGLE_OIDC_ALLOWED_EMAILS`, migration 090).*
- **Open:** the watchdog does not watch cloudflared. The outside heartbeat is the only alert when the
  Mac is off.

## Evidence

All of these ran on 2026-10-03 on this branch:

- `packages/testkit/test/nginx-public-gateway.test.ts`: the production nginx image with a stub Core
  that echoes headers, reached through loopback-published ports as cloudflared reaches it. It covers:
  - the forwarded and stripped headers on both servers;
  - 10 MB admitted and 13 MB refused;
  - 23 paths × 3 methods that design-api must 404, including encoded and dot-segment paths;
  - other Host names on both ports get 404;
  - Desk routes and refusals;
  - the office listener unchanged;
  - per-address rate limits separated by `CF-Connecting-IP` and not by a caller's `X-Forwarded-For`;
  - the access log carries the client address.
- `apps/core/test/office-access-public-gateway.test.ts` (unit), and a case in
  `apps/core/test/trusted-office-access.test.ts` (createApp against the test database). Both failed
  with the header check removed and pass with it.
- `scripts/test/verify-public-gateway.test.ts`: the verifier against fake listeners, a correct one and
  ten one-fault variants, plus the TLS failure and the exit codes of the command.
- `scripts/test/cloudflared-install.test.ts`: install.sh with a fake cloudflared and launchctl (dry
  run, apply, idempotent rerun, port change, existing tunnel, refused DNS, stop), and the template
  read by the real cloudflared offline.
- `nginx -t` in `nginx:1.27-alpine-slim`, and `docker compose config` with the new ports.

## Addendum (2026-10-03): office Google enrolment from an allow-list

**Status:** Implemented on branch `claude/golive`, with migration 090. Not deployed.

### Context

The Consequences above leave one item open: nothing could enrol an office Google account. Core admitted
a Google identity only if 036's `hawa.lookup_office_oidc_user` found a member with that subject.
`hawa.users` forces RLS and has only a read policy, so the application role cannot create a member or
record a subject. The only database function that inserts users (083's
`provision_customer_requester`) makes customer requesters. Also, only Workspace accounts with an `hd`
claim in `HAWA_GOOGLE_OIDC_HOSTED_DOMAINS` were admitted, and the office may use plain Gmail accounts.

### Decision

1. **`HAWA_GOOGLE_OIDC_ALLOWED_EMAILS`** is a comma list of `email:role[+role…]`. The roles are
   `hawa.membership_role` without `requester`. Parsing is strict: a bad email, an unknown role, an
   empty entry, a repeated email or a repeated role throws, and Core does not start. Emails are
   compared lower-cased. `HOSTED_DOMAINS` becomes optional when the list is set. `googleOidcSettings`
   still returns null for an incomplete configuration, and the new key counts towards
   `namedOfficeReviewMode`. The `hd` hint is sent only when there is no list, because it would hide
   Gmail accounts in Google's chooser.
2. **Admission** (`officeIdentityFromClaims`), after openid-client has verified the token:
   - `email_verified === true` is required in every case.
   - A listed email is admitted with its roles, with or without `hd`.
   - Any other account needs an `hd` in `HOSTED_DOMAINS`, and goes through the unchanged subject lookup.
3. **Migration 090** adds two `SECURITY DEFINER` functions in 036's style. Execute is revoked from
   PUBLIC and granted to `hawa_app`, and both refuse any context other than Core's system automation
   in the current tenant.
   - `hawa.enrol_office_oidc_user(tenant, subject, email, name, roles)` is serialised per subject. It:
     - finds the member by subject;
     - otherwise binds the subject to an unbound member with that email, refusing built-in identities
       and refusing (23505 → 403) an email bound to another subject;
     - otherwise creates the member;
     - sets the tenant memberships to exactly the listed roles;
     - records the enrolment in `hawa.office_oidc_enrolments`, a new table that has no policy or grant
       and is reached only through these functions;
     - writes an `office_oidc.enrolled`, `.bound`, `.roles_changed` or `.reinstated` audit event;
     - revokes the member's Desk sessions when its roles change.
   - `hawa.reconcile_office_oidc_enrolments(tenant, list)` takes the whole current list. It revokes
     every enrolled member whose email is no longer listed: its memberships go inactive, its Desk
     sessions are revoked, its enrolment is marked revoked, and an `office_oidc.revoked` audit event
     is written. It also re-syncs changed roles. The subject binding is kept.
4. **When the list is applied.** Core runs the reconciliation at start whenever Google sign-in is
   configured. It runs it again before every callback, and the callback fails closed (503) if it
   cannot. Removing an email therefore takes effect on the redeploy that changes the list: live
   sessions end within the 60-second session recheck, and new sign-ins are refused, even through a
   Workspace domain. An empty or removed list revokes every account it enrolled.
5. **Customer accounts.** An allow-listed `administrator` gets a `google_oidc` session for a member with
   an active administrator membership. That is what `lock_named_office_administrator` (038) requires,
   so `/v1/office/customer-accounts` works without any change to the customer routes.

### Considered and rejected

- **Reusing the seeded Administrator row.** Every Google admin would be the same user as the shared-key
  administrator, which undoes ADR-064's named review.
- **Provisioning through `provision_customer_requester` with a derived subject.** It would label office
  administrators as customers, with a fake customer email.
- **Owner-run SQL**, like 012. That is the ad-hoc production SQL this go-live forbids.
- **Admitting any verified email without a list.** Anyone with a Google account would get a session.

### Consequences

- For an enrolled account, the list is the whole of its tenant role. Roles granted any other way are
  deactivated at its next sign-in.
- There is no supported unbind. If an allow-listed email's Google account is deleted and recreated, the
  new subject is refused, and the lead has to reset it through a reviewed migration.
- For a non-Gmail address, `email_verified` means Google verified the address when the account was
  made. Binding at first sign-in means a later account with the same address and a new subject is
  refused.

### Evidence

`apps/core/test/google-oidc-allowed-emails.test.ts` (11 tests, real test PostgreSQL). Google is mocked
only at the openid-client boundary; the real provider, admission, routes and migration-090 functions
run. It covers:

- strict parsing, and the start-up refusal of a malformed list;
- optional hosted domains, and the incomplete-configuration refusal;
- a Gmail administrator's first sign-in creating the member, the session and the audit event, then
  `GET /v1/office/customer-accounts` answering 200;
- a second sign-in matching the same subject;
- an operator refused customer administration;
- refusals for an unverified email, a string `"true"` for email_verified, an unlisted Gmail, and a
  listed email under another subject;
- the Workspace path unchanged, with and without the list;
- a role change re-syncing the roles and revoking the old session;
- removal revoking the memberships and the live session while keeping the binding, Workspace
  re-entry refused, and re-listing reinstating the member;
- the functions refused outside system automation, and the enrolment table unreadable by `hawa_app`.

Two deliberate faults were each caught by the suite: reconciliation stubbed out, and the
`email_verified` check weakened.
