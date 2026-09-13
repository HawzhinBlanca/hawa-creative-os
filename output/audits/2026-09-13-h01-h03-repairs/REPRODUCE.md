# Reproducing H01–H03 Verification

This document details how to reproduce the verification results for tasks H01 (Canonical Authenticated Task Loading), H02 (Truthful Receipts), and H03 (Strict Approval & Durable State Authority) on the deployed Hawa environment.

## Environment Preconditions

1. Docker production environment running on `http://127.0.0.1:8080` (reverse-proxy port):
   - `core` container: `hawa-production-core-1`
   - `desk` container: `hawa-production-desk-1`
   - `nginx` container: `hawa-production-nginx-1`
   - `postgres` container: `hawa-production-postgres-1`
2. Pinned Docker Image Digests:
   - Core: `hawa-production-core:latest` (manifest sha256: `f12d1e758d3a778a6d433bef2087d55320c5115b89001179364be0935755c186`)
   - Desk: `hawa-production-desk:latest` (manifest sha256: `a84a4c0a410b12a287bafc0ef477a15234b1393b47ceaf6b6dea0343d40775c4`)

## Automated Live Verification Commands

Run from `/Users/hawzhin/Hawdesign`:

```bash
# 1. Run live deployed proxy probes (Port 8080)
pnpm tsx scripts/verify_live_h01_h03.ts

# 2. Run core in-process security and role authority probes
pnpm tsx output/audits/2026-09-12-followup-bug-hunt/core-probes.ts

# 3. Run full @hawa/core test suite
pnpm --filter @hawa/core test
```

## Expected Outcomes

1. **Unauthenticated Task List:**
   - `GET http://127.0.0.1:8080/v1/tasks` returns `HTTP 401 Unauthorized` with `Content-Type: application/json` and RFC 7807 problem details.
   - Never returns `HTTP 200 text/html` with an SPA HTML shell.
2. **Session Login:**
   - `POST http://127.0.0.1:8080/v1/auth/session` with `HAWA_REVIEWER_KEY` returns `HTTP 201 Created` with `user.role: "art_director"` and an authenticated session bearer token.
3. **Authenticated Task Loading:**
   - `GET http://127.0.0.1:8080/v1/tasks?limit=10&offset=0` with session token returns `HTTP 200 OK` with paginated database items (total 1,450 tasks).
4. **Action Schema & Enum Validation:**
   - `POST .../decisions` with `{ action: 'invalid_action_foo' }` returns `HTTP 400 Bad Request`.
5. **Role Authority & Spoofing Defense:**
   - `POST .../decisions` with `{ action: 'approve', role: 'art_director' }` using operator credentials and spoofed header `x-user-role: art_director` returns `HTTP 403 Forbidden`.
   - Client role assertions are strictly ignored in production mode.
6. **Approval Mapping Integrity:**
   - `POST .../decisions` with `{ action: 'approve' }` using legitimate reviewer credentials maps cleanly to `approved` and is never converted to `revision_requested`.
