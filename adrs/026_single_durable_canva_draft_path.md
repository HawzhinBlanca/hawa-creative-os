# ADR 026 — One durable Canva draft path, honest chat outcomes, no default credentials
Date: 2026-09-13. Status: accepted (independent review of the 10/10 qualification working tree).

## Context
The working tree that claimed 10/10 ship readiness produced the automatic Canva draft twice for
every Telegram request: inline inside the webhook handler (model call plus Canva import while the
poller waited, request key `tg_<task>`, 1080×1350) and again in the Restate worker (`workflow-<task>`,
1200×1697). The second path received `GENERATION_CONFLICT` and, because Core's 4xx answers were not
terminal, Restate retried it forever. Unknown senders were silently attributed to KAAE so that the
inline path had a client to spend against. Production ran with the webhook secret and the Telegram
bot token that are committed in git, and the secret scanner had been weakened until it reported zero.

## Decision
1. The Restate worker is the only place that plans, imports and captures a Canva draft. The webhook
   only persists the request (with the requested artboard size in the outbox payload) and acknowledges.
2. Core answers that refuse a request (4xx other than 408/429) are terminal for the workflow. The worker
   reports every terminal outcome to `POST /v1/tasks/:taskId/notifications/canva-status`, which sends
   the requester an escaped, truthful HTML message: the Canva link when a design exists, otherwise why
   not (Kurdish copy unsupported, no brand reference pack, unscoped client, uncertain result).
3. Unrecognised client aliases stay unscoped (`client_id = NULL`) and never trigger automatic drafting;
   the art director assigns them in Hawa Desk. Known aliases resolve to their seeded client rows.
4. The Telegram webhook secret authenticates webhook deliveries only; it is not an API credential.
5. No compose default may be a usable credential. `DATABASE_URL`, `POSTGRES_PASSWORD`, the Telegram
   secret and the office allowlists come only from the ignored env files; missing values fail `compose config`.
6. The secret gate scans exactly what git would commit, with typed patterns (hex keys, database URLs,
   bot tokens, provider keys) and an explicit, justified allowlist. Heuristic skips are not accepted.
7. SLO telemetry starts empty; no seeded successful probes.

## Consequences
Automatic drafting is slower to answer (minutes, not seconds) but survives restarts and never runs
twice. Requesters always receive a final message. A deploy now requires `infra/docker/.env` and a
complete `.env.production`; the committed credentials must be rotated (see the independent review).
Kurdish-copy and non-KAAE requests are honestly reported as manual work until those admissions exist.
