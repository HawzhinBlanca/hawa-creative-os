# Go live: hawzhin.app customers and the public Desk (ADR-294)

The customer website stays on Lovable at **https://hawzhin.app**. Its browser code calls Hawa's customer
API at **https://design-api.hawzhin.app/v1/customer/\***. The office uses the Desk at
**https://desk.hawzhin.app** with Google sign-in. Both names reach the office Mac through a Cloudflare
named tunnel (`hawa-office`). Nothing on the Mac listens publicly.

```
browser ── https ──> Cloudflare ── tunnel (outbound from the Mac) ──> cloudflared (launchd, com.hawa.cloudflared)
   design-api.hawzhin.app, path ^/v1/customer/  ──> 127.0.0.1:8081  nginx: /v1/customer/* only, else 404
   desk.hawzhin.app                             ──> 127.0.0.1:8082  nginx: Desk + office API, sign-in required
   anything else                                ──> 404 at the tunnel
office Mac only:                                    127.0.0.1:8080  nginx office listener, unchanged
```

Each step below says who does it: **owner**, **lead** (the engineer who deploys) or **website** (Codex,
in the website repository). Do the steps in order. Every step has a check. Do not go on until the check
passes.

This runbook names environment variables only. Their values go through the deployment's secret path,
never into chat, commits or evidence.

## What must be true first

- The live engine release contains ADR-294. That means the nginx public listeners, the
  `X-Hawa-Public-Gateway` refusal in Core and `scripts/verify_public_gateway.ts`. Before any deploy,
  check `readlink ~/.hawa/current`, because Codex deploys too
  (`runbooks/PRODUCTION_RELEASE_DIRECTORIES.md`).
- Migrations through 090 are applied in production (the customer tables 083–087 included, and 090,
  the office Google enrolment functions).
- Office Google accounts are enrolled from `HAWA_GOOGLE_OIDC_ALLOWED_EMAILS` (step L4, ADR-294
  addendum). Do not run ad-hoc SQL on production to enrol anyone.

## Owner steps

**O1. Add hawzhin.app to Cloudflare.** Use the Free plan. In the Cloudflare dashboard choose
*Add a site*, enter `hawzhin.app`, and let it scan the existing records.

Compare the scan, record by record, with the current DNS at the registrar and with Lovable's
*Domains* settings. Copy anything the scan missed. Keep these exactly as they are:

- Lovable's records for `@` and `www`, and its verification TXT. Leave them **DNS only** (grey cloud):
  Lovable issues and renews its own certificate, and proxying can break that.
- Every mail record: MX, SPF TXT, DKIM, DMARC.

Do **not** create `design-api` or `desk` records by hand. Step L2 creates them.

If DNSSEC is on at the registrar, turn it off before O2. Turn it back on from Cloudflare once the zone
is active.

*Check:* the record list in Cloudflare matches the registrar's list, apart from the two new names.

**O2. Point the nameservers at Cloudflare.** At the registrar, replace the nameservers with the two
that Cloudflare shows.

*Check:* Cloudflare marks the zone **Active** (minutes to hours). After that, https://hawzhin.app
still loads the website and mail still arrives.

**O3. Set the zone's options.**

- SSL/TLS → Edge Certificates: *Always Use HTTPS* on, *Minimum TLS* 1.2.
- Leave these off: *Bot Fight Mode* (on the Free plan it cannot be limited to one host, and it can
  challenge the website's API calls), *Rocket Loader*, and any feature that rewrites responses.

**O4. Log cloudflared in on the office Mac.** Use the macOS account that runs production.

```
brew install cloudflared        # if `cloudflared --version` fails
cloudflared tunnel login        # a browser opens: choose the hawzhin.app zone
```

*Check:* `~/.cloudflared/cert.pem` exists. It is an account credential: never copy it anywhere.

**O5. Create the Google OAuth client for the Desk.** In the Google Cloud console (any project the
owner controls):

1. Set the OAuth consent screen's user type:
   - **External** if any office account is a plain Gmail (or other non-Workspace) account. Leave the
     app in *Testing* and add every office email as a **test user**: the same emails as in
     `HAWA_GOOGLE_OIDC_ALLOWED_EMAILS`. Scopes are only `openid`, `email` and `profile`, so no Google
     verification is needed. (In *Testing*, Google asks each user to sign in again after 7 days; this
     only affects Google's own consent, not Hawa's 8-hour sessions.)
   - **Internal** if every office account is in the office's Google Workspace.
2. Create the client under *Credentials → Create credentials → OAuth client ID*:
   - Application type: **Web application**
   - Name: Hawa Desk
   - Authorized JavaScript origins: `https://desk.hawzhin.app`
   - Authorized redirect URIs: `https://desk.hawzhin.app/auth/google/callback`
3. Write the list of office accounts and their roles as `email:role` entries, comma-separated, for
   example `owner@gmail.com:administrator,designer@gmail.com:operator+approver`. The owner's own
   account must be `administrator` (step L6 needs it). Roles: administrator, approver, operator,
   designer, language_reviewer, client_dna_manager, model_evaluator, auditor. Write each email exactly
   as Google shows it for the account.
4. Optionally, the Workspace domain or domains whose already-provisioned accounts may sign in.

Give the lead the client ID, the client secret, the account list and any domain through the secret
path. The lead turns them into `HAWA_GOOGLE_OIDC_CLIENT_ID`, `HAWA_GOOGLE_OIDC_CLIENT_SECRET`,
`HAWA_GOOGLE_OIDC_ALLOWED_EMAILS` and (optionally) `HAWA_GOOGLE_OIDC_HOSTED_DOMAINS`.

**O6. Add the Canva redirect.** In the Canva developer portal, add this authorized redirect to the Hawa
integration: `https://desk.hawzhin.app/v1/integrations/canva/callback`. Keep the old one until step L3
has been done.

**O7. Hand over the website's publishable auth key.** This is the hawzhin.app workspace's
publishable (public) auth key, the same project the website signs in with. It goes to the lead as
`HAWA_CUSTOMER_AUTH_PUBLISHABLE_KEY`.

**O8. List the first customers.** For each one, give:

- their hawzhin.app account id (the auth user UUID);
- the Hawa client or clients they may design for (client UUIDs, at most 20);
- a daily job limit (1–100) and a concurrent job limit (1–10).

## Lead steps

**L1. Deploy the engine release with ADR-294, configuration unchanged.** Use the normal
`infra/docker/deploy.sh` from a detached worktree. Compose now publishes nginx on
`127.0.0.1:8081` and `127.0.0.1:8082` as well as 8080, so this deploy recreates nginx once.

*Check:*

```
lsof -nP -iTCP:8081 -iTCP:8082 -sTCP:LISTEN          # only 127.0.0.1, never *:
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: design-api.hawzhin.app' http://127.0.0.1:8081/v1/health   # 404
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/v1/health                                     # 200, office unchanged
```

**L2. Install the tunnel.** Do this only after O1–O4.

```
infra/cloudflared/install.sh            # dry run: read what it will do
infra/cloudflared/install.sh --apply
```

The script does four things:

1. Creates the tunnel `hawa-office`, unless it already exists.
2. Renders `infra/cloudflared/config.template.yml` into `~/.cloudflared/config.yml`.
3. Runs `cloudflared tunnel route dns` for both names. It never overwrites a record that points
   elsewhere.
4. Installs the launchd agent `com.hawa.cloudflared` (KeepAlive; logs in
   `~/.hawa/logs/cloudflared.{out,err}.log`).

If `HAWA_CUSTOMER_GATEWAY_PORT` or `HAWA_DESK_GATEWAY_PORT` is set in `infra/docker/.env`, export the
same values before running it.

*Check:*

- `cloudflared tunnel info hawa-office` shows connections.
- `pnpm exec tsx scripts/verify_public_gateway.ts https://design-api.hawzhin.app` already passes the
  TLS, 404 and preflight checks.
- The session and Desk checks still fail at this point. That is expected until L3: the customer API
  is off and the Desk has no Google sign-in.
- Even now nothing is exposed. The public listeners never forward the office proof, and Core refuses
  trusted-office access on any request nginx marks `X-Hawa-Public-Gateway`.

**L3. Switch Core to required sign-in and turn the customer API on, with generation off.** Change
`.env.production` through the deployment's normal path (`~/.hawa/shared`, then deploy). Set:

| Variable | Set to |
|---|---|
| `HAWA_DESK_AUTH_MODE` | `required` |
| `HAWA_GOOGLE_OIDC_CLIENT_ID`, `HAWA_GOOGLE_OIDC_CLIENT_SECRET`, `HAWA_GOOGLE_OIDC_ALLOWED_EMAILS` | from O5 |
| `HAWA_GOOGLE_OIDC_HOSTED_DOMAINS` | from O5, or unset (optional when `HAWA_GOOGLE_OIDC_ALLOWED_EMAILS` is set) |
| `HAWA_GOOGLE_OIDC_REDIRECT_URI` | `https://desk.hawzhin.app/auth/google/callback` |
| `HAWA_PUBLIC_URL` | `https://desk.hawzhin.app`. `PUBLIC_TUNNEL_URL` must be unset: it is read first. |
| `HAWA_JUDGE_BASE_URL` | `http://127.0.0.1:8080`. Judge links stay office-only, because the public Desk does not serve `/api/`. |
| `CANVA_REDIRECT_URI` | `https://desk.hawzhin.app/v1/integrations/canva/callback` (after O6) |
| `HAWA_CUSTOMER_API_ENABLED` | `on` |
| `HAWA_CUSTOMER_AUTH_PUBLISHABLE_KEY` | from O7 |
| `HAWA_CUSTOMER_GENERATION_ENABLED` | unset or `off` |

Leave these as they are:

- `HAWA_TRUSTED_OFFICE_ORIGIN`: a private address, read only in trusted_office mode. Never set it to
  the public Desk.
- `HAWA_OFFICE_PROXY_PROOF`: kept so a rollback can return to trusted_office.

Core refuses to start with the customer API on in trusted_office mode, or without the publishable
key.

Deploy. From now on the office signs in at **https://desk.hawzhin.app**, on the Mac too:

- The Desk on `http://127.0.0.1:8080` no longer opens without sign-in.
- Its cookie writes fail the CSRF origin check, because the browser origin is now the public Desk.
- Scripts that relied on trusted-office headers on 8080 (for example
  `plans/kaae-2025-guideline/apply-kaae-dna-2025.sh`) need a bearer key instead.
- Health probes and deploy checks on 8080 are unchanged.

*Check:*

- `pnpm exec tsx scripts/verify_public_gateway.ts https://design-api.hawzhin.app` ends with
  `all N checks passed`.
- Run it again from a machine outside the office network, for example a phone hotspot.

**L4. Enrol office Google accounts (ADR-064, ADR-294 addendum).** Nothing to run: each account on
`HAWA_GOOGLE_OIDC_ALLOWED_EMAILS` is enrolled the first time it signs in at https://desk.hawzhin.app.
Core admits it only after openid-client has verified Google's token, and only if Google says the email
is verified (`email_verified: true`) and the email (any case) is on the list. Migration 090's
`hawa.enrol_office_oidc_user` then creates the office member, or binds the Google subject to an
unbound member with that email. It gives the member exactly the listed roles and records an
`office_oidc.enrolled` (or `.bound`) audit event. Later sign-ins match by subject.

- **To remove someone:** delete their entry and redeploy. At start, and again before every sign-in,
  Core revokes every enrolled account whose email is no longer listed: its memberships go inactive, its
  Desk sessions are revoked, and an `office_oidc.revoked` audit event is written. The subject binding
  stays, so the email cannot come back under a different Google account.
- **To change a role:** edit the entry and redeploy. The member's sessions are revoked, and the next
  sign-in carries the new role.
- **An email already bound to a different Google account** is refused (403). There is no supported
  unbind; ask the lead.
- The Workspace path is unchanged. An account in `HAWA_GOOGLE_OIDC_HOSTED_DOMAINS` that is not on the
  list still signs in only if it was provisioned by subject before.

*Check:* the owner signs in at https://desk.hawzhin.app with Google, and *Settings* shows a named
administrator. `GET /v1/office/customer-accounts` from that session answers 200.

**L5. Reconnect Canva from the public Desk.** Canva connections belong to the signed-in Hawa user.
Each office member who designs connects Canva from *Settings* at https://desk.hawzhin.app.

*Check:* `GET /v1/integrations/canva/status` shows `configured: true` with the new redirect, and the
Desk shows the account connected. Also confirm the design worker's Canva calls still succeed: open one
existing task's Canva state.

**L6. Provision the customer accounts.** This needs a Google-signed-in named administrator. In the
Desk at https://desk.hawzhin.app, open the browser console and run the following once per customer
from O8 (placeholders in capitals):

```js
const csrf = document.cookie.match(/(?:^|; )hawa_csrf=([^;]+)/)[1];
await fetch('/v1/office/customer-accounts', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID(), 'X-Hawa-Csrf': csrf },
  body: JSON.stringify({ subject: 'CUSTOMER_ACCOUNT_UUID', clientIds: ['CLIENT_UUID'], active: true,
    expectedVersion: 0, dailyJobs: 5, concurrentJobs: 1, reason: 'Owner admitted CUSTOMER on DATE' }),
}).then(r => r.json());
```

For an account that already exists, use the `version` from the read-back as `expectedVersion`.

*Check:* `await fetch('/v1/office/customer-accounts').then(r => r.json())` lists each account as
active. Then a customer signs in on https://hawzhin.app and `/designer` shows their session, with
generation reported off.

## Website steps (Codex, website repository)

**W1. Point the website at the API.** Set the customer API origin to `https://design-api.hawzhin.app`.
This is the build variable the website already uses (`VITE_HAWA_CUSTOMER_API_ORIGIN`), and the value
must stay in its hard-coded allowlist. Keep the Designer launcher at *soon*. Publish on Lovable.

**W2. Use the real domain only.** Core's CORS admits only `https://hawzhin.app` and
`https://www.hawzhin.app`. Lovable preview domains (`*.lovable.app`) are refused, as intended. Test
on https://hawzhin.app.

*Check:* signed in, `/designer` loads the session from design-api, and the browser console shows no
CORS errors. Signed out, the website shows sign-in rather than an error.

## Turning generation on

**G1.** Set `HAWA_CUSTOMER_GENERATION_ENABLED=on` and deploy. Then the website (Codex) moves the
Designer launcher from *soon* to live and publishes.

*Check:* run `scripts/verify_public_gateway.ts` again, then do the two-user test below.

## Two-user live test (both on real devices, at least one a phone off the office network)

Accounts A and B are admitted for different clients.

1. A signs in on https://hawzhin.app, opens Designer and sees only A's clients. B does the same and
   sees only B's.
2. A uploads 2–6 photos and submits one request with exact copy, in Sorani and English. One request
   and one quota reservation appear, including after a double-click or reload.
3. The office sees A's request at https://desk.hawzhin.app after Google sign-in. The Desk on the Mac
   at 127.0.0.1:8080 no longer opens without sign-in.
4. A receives a preview, asks for one revision, receives the revised preview, accepts, and downloads
   PNG and PPTX. The hashes match what the Desk shows. The PPTX opens editable.
5. B cannot see A's job by id: tamper with the URL or the request, and the answer is not found or
   denied, never A's data. The same holds for preview, review and download links copied from A.
6. A signs out. Their old token is refused (401) and the website asks for sign-in again.
7. Limits hold:
   - A's daily limit (set it to 1 for the test) refuses the next request with a clear message.
   - Twenty fast reloads from one phone are not refused for the other user. nginx's per-address
     limits count each Cloudflare client address separately.
   - `docker logs hawa-production-nginx-1` shows the phones' public addresses, not `172.x.0.1`.
8. Restart Core during A's generation (`deploy.sh` or the watchdog). A's job resumes, with no
   duplicate paid call or second job.
9. Record the evidence: request and task ids, hashes, timings and spend, with no tokens or cookies.
   Put it in the release's evidence. Mark anything not exercised as not exercised.

## Rollback

Fastest first. Each step is independent and reversible.

1. **Tunnel off.** Run `infra/cloudflared/install.sh --stop --apply`. Both public names stop answering
   (Cloudflare 530/1033) at once. The office keeps 127.0.0.1:8080, but the Desk there needs sign-in
   until step 3. `install.sh --apply` brings the tunnel back, with the same DNS and tunnel.
2. **Generation off.** Set `HAWA_CUSTOMER_GENERATION_ENABLED=off`, or `HAWA_CUSTOMER_API_ENABLED=off`
   for the whole customer API, and deploy. Then the website (Codex) sets Designer back to *soon*.
3. **Office back to no sign-in** (only with the tunnel off and `HAWA_CUSTOMER_API_ENABLED=off`): set
   `HAWA_DESK_AUTH_MODE=trusted_office`, with `HAWA_TRUSTED_OFFICE_ORIGIN` and
   `HAWA_OFFICE_PROXY_PROOF` unchanged, and deploy. Core refuses trusted_office while the customer API
   is on.
4. **Engine rollback.** This is the previous release (`runbooks/PRODUCTION_RELEASE_DIRECTORIES.md`).
   A release before ADR-294 has no public listeners. Turn the tunnel off first, or cloudflared
   reports 502 for both names.

DNS stays on Cloudflare in every case. Moving the nameservers back is not part of the rollback.

## Operating notes

- **Logs.** cloudflared writes to `~/.hawa/logs/cloudflared.err.log`. nginx's access log shows each
  public caller's real address.
- **Slow requests.** Cloudflare ends any request that has no response within 100 s (524). The Desk's
  event stream is unaffected: it sends a ping every 15 s.
- **Uploads.** Photos are limited to 10 MB by Core and 12 MB by nginx. Cloudflare's Free plan admits
  100 MB.
- **Availability.** The tunnel depends on the Mac being awake and logged in, like Docker Desktop. The
  watchdog does not check cloudflared yet (open item). The outside heartbeat (`HAWA_HEARTBEAT_URL`)
  is the only alert when the Mac is off.
