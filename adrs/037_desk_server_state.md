# ADR-037: The Desk Keeps Server State in TanStack Query

**Date:** 2026-09-24
**Status:** Accepted 2026-09-24 by the owner ("yes, do all"). Implemented 2026-09-24 on branch `worktree-wf_93123f63-474-3` (architecture programme, Phase 1.5); not yet merged or deployed.
**Adds:** `@tanstack/react-query` v5 to `apps/desk` (its runtime dependencies today are react, react-dom and dompurify).

## 1. Context: the measured need

AGENTS.md admits a dependency only with a measured need. The Desk review of 2026-09-24 found:

- the queue never refreshed when a draft arrived and showed only the newest 50 tasks;
- a failed read looked like "no changes", and an expired session froze every screen but one;
- the fixes, written by hand, now read every page of `/tasks` every 30 s and 1 s after every task event, each row costing six correlated subqueries; the sidebar polls the heavy health handler every 30 s even in hidden tabs.

All of these are server-state concerns (caching, refetch on focus and interval, invalidation from events, paging, one error path for 401) that the Desk implements by hand, screen by screen.

## 2. Decision

TanStack Query v5 with:

- numbered pages with `placeholderData: keepPreviousData` and a server total (an invalidation refetches one page; infinite scroll would refetch every loaded page in sequence);
- one event stream per tab; `task:*` events invalidate `['tasks']` and `['task', id]`, coalesced over 300 ms (applied once events pause for 300 ms, at the latest 1 s after the first); everything is invalidated after a reconnect; polling runs only while the stream is down;
- one 401 handler in `QueryCache` and `MutationCache` (clear, drop the token, sign in once);
- approve and revise show pending state in the UI and never change the cached status before the server confirms (approval has server side effects and can be refused);
- `retry` off for 401 and 403 (and 404: a stale link, a deleted task), at most two retries otherwise; `staleTime` about 30 s.

## 3. Consequences

- Size, measured with `vite build` on 2026-09-24 against the same Desk at 79b70e0 (498.68 kB, 146.40 kB gzip, one chunk): TanStack Query and the new Desk code in one chunk came to 540.87 kB (158.60 kB gzip), over the 500 KiB entry budget that CV-17 (`apps/core/test/hawa-work-desk-cv17.test.ts`) sets. The budget is kept, not raised: the Work screen stays in the entry chunk and the Clients, Settings, Ops, Eval and Comparison screens load on first visit (`React.lazy`). Entry chunk 414.42 kB (127.82 kB gzip); the five screen chunks 128.9 kB (36.1 kB gzip) together. CV-17 now measures the chunk `index.html` loads, and every chunk against the same limit.
- "Polling only while the stream is down" relies on the stream failing visibly. Core ends the response when the heartbeat (15 s) finds its session revoked or expired, so the browser reconnects, the ticket request meets the 401 and the Desk shows sign-in; the Desk also treats a stream silent for 45 s as down.
- Deploy: a Desk cached by the service worker from before this change still opens the stream with `?access_token=`, which Core now refuses. It reconnects with a 401 every 10 s or less and polls until the new Desk loads (a reload). It degrades; it does not break.
- The hand-written polling, paging and 401 paths are deleted.
- The server-side changes (keyset pages, lean list query, indexes, a stream ticket instead of the session token in the URL) are made with it.

## 4. Alternatives considered

- **SWR:** smaller, weaker mutation tooling, no devtools.
- **React Router loaders:** run on navigation only; no cache, polling or refetch on focus; the Desk has no router.
- **Keep the hand-written code:** it produced the four bugs above and the current load.
