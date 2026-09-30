# Durable requester hold reliability

Date: 2026-10-01. Branch: `codex/requester-hold-reliability`.
Base: a577df58, preserving the verified live 4e500451 infrastructure repairs.
Requirements: FR-004, FR-005, FR-060, FR-063, NFR-001, NFR-006.
Decision: ADR184. Specification: messaging/inbox, workflow reliability and security.

## Acceptance scope

1. S086 passes as an ordinary test with an authoritative paused task.
2. Current requester/chat scope and ambiguity rules determine the held task.
3. Pause, original words and intake receipt commit atomically; historical replay
   cannot re-pause a design after office resume.
4. New paid admission waits behind the same task lock and refuses a paused task;
   results/cost of an already admitted call remain recordable.
5. Worker pause answers and timers survive replay, preserve stable keys and saved
   stages, and do not abandon or report a failed design solely because of a hold.
6. Outcomes wait before projection; office resume checks the current owner,
   request revision, task version, human authority and saved checkpoint.
7. Desk shows original words and a resume action; requester status reports pause.
8. Connected tests, full regression, types, lint, Desk build and blueprint evidence
   pass before sealing. Deployment and native-language admission are separate.

## Remaining boundaries

Initial-brief settlement versus the first paid admission remains unqualified.
Later-stage holds pass to the office with existing delivery fencing; they do not
claim an automatic task pause. The two ADR182 defects in title extraction and
multi-design requests remain expected failures. Broader W3/W5/W6 design work,
exact photo counts, native typography/Canva and human-quality proof remain open.
The overall implementation goal remains active.
