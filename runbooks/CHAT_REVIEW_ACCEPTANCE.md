# Chat review acceptance (ADR-065)

Requirements: FR-041, FR-043, FR-044, FR-060, NFR-015. Local test evidence is in
`plans/research-grade-upgrade-2026-09-25/R08_EVIDENCE.md` nineteenth pass.

## Deployment prerequisites

- Apply the versioned upgrades through `039_office_review_return.sql` using the
  normal deployment migration gate, before starting this Core candidate.
- Configure the public HTTPS Desk origin via `PUBLIC_TUNNEL_URL`, `HAWA_PUBLIC_URL`
  or `HAWA_DESK_BASE_URL` (first nonempty value in that order). Intake's explicit
  Desk base takes precedence for its initial notice. Use an origin such as
  `https://desk.example.org`, without credentials, extra path, query or fragment.
  An absent or invalid first configured value omits the link, without trying a
  different destination. The public origin must serve this Core and Desk and
  match the Google Workspace callback deployment. Never infer it from Host.
- Complete ADR-064 Google configuration and verified subject/membership bootstrap.
  A named administrator assigns each reviewer to the relevant client/project in
  Desk Settings. A shared key or link alone grants no review authority.
- Set the intended office Telegram recipient through the existing office channel
  configuration. A lifecycle ready-draft outcome alerts that office recipient if
  it differs from the requester, and stores the same revision-bound link in the
  replay receipt. Do not copy sign-in cookies or provider secrets into evidence.

## Live acceptance on the exact candidate

1. Submit an authorized office brief, record task/revision and the notification
   message receipt. Open **Open review in Hawa Desk** on desktop and mobile.
2. Start signed out. Complete Google sign-in and confirm the same task and revision
   open, including when the task is outside the first queue page. Confirm there
   is still no approval until the reviewer inspects the capture and decides.
3. Open the link with a reviewer assigned to another client. The server must
   refuse a decision and record no approval. Repeat after revoking the original
   reviewer's assignment/session; use a newly authorized reviewer to continue.
4. Create and capture a newer design revision. Open the old notification. Desk
   must show the old-revision notice and disable approve/revise/reject. Choose
   **Review current revision**, inspect its evidence, then record the decision.
   Record exact revision, QA/export hashes, named actor and assignment version.
5. Replay the notification outcome across a Core restart: its stored link must
   stay the same and no duplicate external message or decision may be inferred
   from a missing response. Exercise the existing reconciliation controls.
6. Complete delivery with the approved bytes and record actual Drive, Sheets and
   Telegram receipts. The local handoff tests do not qualify those providers.

Retain timestamps, source/image identity and redacted receipts for each step.
Stop release admission on any failed check. Keep lifecycle production flags off
until the other workflow, restore, export and independent human quality gates in
`WORK_ITEMS.csv` pass; this handoff is one connected acceptance slice.
