# Runbook: Security or Cross-Client Incident

## Immediate

- stop affected integration/model/studio/publication path;
- preserve logs, audit, source, traces, and access evidence;
- revoke/rotate suspected credentials;
- isolate WAHA/ComfyUI or affected worker;
- prevent further Drive/source sharing;
- notify designated incident owner.

## Assess

- affected tenant/client/task/data classes;
- exposure versus attempted access;
- users/services/credentials involved;
- external providers/files/links;
- approved/published outputs potentially contaminated.

## Recover

- correct authorization/RLS/config;
- restore clean source/data if modified;
- invalidate signed links/sessions/approvals;
- rerun affected task QA/review;
- verify no other client contamination;
- add adversarial regression tests.

Database evidence must not be manually erased. Follow legal/client notification obligations applicable to the office.
