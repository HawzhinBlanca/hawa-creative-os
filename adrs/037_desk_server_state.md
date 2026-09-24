# ADR-037: The Desk Keeps Server State in TanStack Query

**Date:** 2026-09-24
**Status:** Accepted 2026-09-24 by the owner ("yes, do all"); implementation in progress (architecture programme, Phase 1.5).
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
- one event stream per tab; `task:*` events invalidate `['tasks']` and `['task', id]`, coalesced over 300 ms; everything is invalidated after a reconnect; polling runs only while the stream is down;
- one 401 handler in `QueryCache` and `MutationCache` (clear, drop the token, sign in once);
- approve and revise show pending state in the UI and never change the cached status before the server confirms (approval has server side effects and can be refused);
- `retry` off for 401 and 403, at most two retries otherwise; `staleTime` about 30 s.

## 3. Consequences

- About 13 kB min+gzip (measured in the Vite build before merging).
- The hand-written polling, paging and 401 paths are deleted.
- The server-side changes (keyset pages, lean list query, indexes, a stream ticket instead of the session token in the URL) are made with it.

## 4. Alternatives considered

- **SWR:** smaller, weaker mutation tooling, no devtools.
- **React Router loaders:** run on navigation only; no cache, polling or refetch on focus; the Desk has no router.
- **Keep the hand-written code:** it produced the four bugs above and the current load.
