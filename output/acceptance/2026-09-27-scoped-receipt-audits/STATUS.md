# Scoped receipt audit qualification — 2026-09-27

## 2026-09-27 — Durable scoped receipt audits (ADR-103), qualification pending

PostgreSQL now retains immutable actor/current-client-scope audit history. Source
reads and append use one serializable snapshot; exact action replay recovers the
original report after lost replies and restart. Current RLS refuses another actor
or changed client scope. Current-revision manifest/hash/size and observed Sheet
row hashes prevent older or incomplete receipts from qualifying a new delivery.
The Desk saves actions before transport, retains uncertainty across reload, and
clears failed or contradictory reads. Simulation and repair inputs are refused.

The authenticated original Core reproduces three failures (cross-user report,
revocation and restart). Corrected affected group: 123 tests/11 files; extra
snapshot/lineage and Desk checks: 18/3; final migration/header/parser group: 40/6.
These overlap. Source/scripts and all 503 strict roots compile, lint and Desk build
pass; security scan and 11-pattern self-test pass. Initial fixture, outdated test
expectation and timestamp-precision failures are preserved. Full regression and
fresh deployed Chrome/restart checks remain pending. No live provider or production
change. External scheduled Drive/Sheets reconciliation, independent availability,
other recovery, native Canva/live/human admission and independent-host restore remain
open. See R02_SCOPED_RECEIPT_AUDITS_PROOF.json and runbooks/SCOPED_RECEIPT_AUDITS.md.
