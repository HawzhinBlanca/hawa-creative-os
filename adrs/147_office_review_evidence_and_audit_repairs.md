# ADR-147 — Office review evidence and audit repairs

Date: 2026-09-30
Status: implementation under verification
Requirements: FR-006, FR-052, FR-069, FR-077, NFR-012, NFR-016.
Sources: docs/09_MESSAGING_AND_OFFICE_INBOX.md, docs/17_UI_UX.md,
docs/18_FEEDBACK_LEARNING.md, MASTER_SPEC.md; compact audit report
output/audits/2026-09-29-office-flow-audit/REPORT.md.

## Decision and reason

Keep the existing database, client scope, Studio pipeline, Canva handoff and
private-office access policy. A concept without a rendered picture cannot be
review evidence. Desk starts feedback with no verdict or rating, resets it when
the candidate changes, and Core binds a rendered candidate to its run and task
under authenticated RLS before recording feedback. Fractional ratings are refused.
Migration 069 retains the exact reviewed preview hash; historical feedback stays
explicitly unbound. Desk saves a UUID and frozen review before transport and
retains it across lost responses/remounts. Core serializes that UUID and checks
its payload on replay. A changed preview requires a new inspection.
Feedback does not release a design or activate brand rules.

Search includes the original request and exact copy. PostgreSQL applies matching
before its bounded read, using the retrieval engine's token and Arabic/Sorani
normalization semantics; unrelated recent tasks no longer hide old matches.
The existing retrieval engine still ranks results. Match truncation stays visible.
There is no new search service, embedding dispatch or dependency.

Work opens to actionable requests, shows the saved request and photos before
generation, and labels unrendered concepts accurately. Retry uses ADR-142's
current-policy bounded action; it does not erase old reservations, increase limits
or imply success. Spending and raw diagnostics remain inspectable.

Search has combobox/listbox selection semantics; preview buttons are keyboard
accessible with dialog focus containment and return. Required form fields and
disabled actions explain the missing input. Canva setup has a direct Settings
action. Brand controls name the affected color and offer revision-checked undo
as a new immutable version. Palette contrast identifies the actual text/background
pair; a background color is not labelled a failure against itself.

## Acceptance and limitations

Required: guarded feedback negative controls; request/copy search beyond the
read ceiling with client isolation and normalized text; real React interaction
checks; compiler and release gates; fresh compact, desktop and RTL browser checks.
Evidence will be appended after execution. No creative-quality, customer launch,
live provider availability, human approval or delivery claim follows from UI tests.
Current model-to-Canva pilot and operational readiness must be checked separately.

## Executed source acceptance

2026-09-30: seven focused files, 80 tests passed, zero failed or skipped.
All 601 test roots compile. Desk production bundle builds. Initial search SQL
uuid/text failure and browser barrel-import failure were repaired and rerun;
logs are retained rather than hidden. Palette removal/undo uses expected versions
1 then 2 in a React regression; no live brand edit was performed. Source scope
is implemented; deployment, live viewport checks and provider pilot remain open.
Evidence: output/repairs/2026-09-30-office-flow/focused-final.log,
test-typecheck.log, desk-build.log. Tests use isolated PostgreSQL and mocked
external providers; they do not establish live creative quality.

Preflight readiness review also found Studio's transferred editor link used the
API path as a browser URL. The release was stopped during stage 8, before live
services changed. Studio now invokes Work's existing authenticated editor lookup,
which opens the provider's scoped edit URL. This is included in the next seal.

The first completed full suite returned 5423 passed, 3 failed, 67 skipped (600
files). Two expected-upgrade fixtures still ended at migration 068; the session
interaction expected the old default-All empty message. Explicit fixture lists
now include 069, and Work uses a human-readable actionable empty message. All
45 tests across the three affected files passed on rerun. The failed full log
is retained as full-suite-first.log; the full release gate will be rerun on the
corrected seal before deploying. No failed or skipped test is counted as passed.

The corrected full release gate passed 5426 tests, with 67 explicitly skipped,
and deployed seal 382f3071 on 2026-09-30. A final storage-boundary review found
the new feedback hash was absent from blob_references. Migration 070 adds it
to the existing retention view (including every prior branch) and indexes it.
This prevents nightly collection of an old reviewed picture when a candidate's
current preview is replaced. A collector regression references the picture only
through feedback, backdates it past the grace, and exercises both direct sweep
and mark/sweep under the application role. Historical null hashes stay unknown.
The retention correction will be independently qualified before readiness.

Retention/source schema checks: 30 tests in three files passed, zero failed or
skipped (retention-tests.log). Release preflight and live migration receipt for
070 are still required.

Live checking of the deployed 382f3071 seal exposed a rendering regression:
Studio and Canva setup had been inadvertently nested under latestRevision.
They now render with saved request/photos outside the captured-preview condition.
A full Work interaction checks an uncaptured task retains both preparation panels
while final approval remains disabled. Earlier unit tests did not cover this
condition; that deployment is superseded by the next qualified seal.

The narrow live search screenshot also exposed the long client name clipping
outside the dialog header. Its scope indicator now wraps below the query, which
can shrink within the viewport. This receives a fresh compact screenshot after
deployment; a style inspection alone is not visual acceptance.

The next preflight stopped at test typechecking: the new interaction queried an
HTMLElement's button-only disabled property. It now checks the DOM disabled
attribute. No deployment happened from that failed run. Compact Settings was
also found to inherit a two-column grid with intrinsic table widths. Provider
setup cards now use bounded responsive columns, with the adapter table in its
own named keyboard-focusable scroll region; setup modal widths are bounded by
the viewport. Fresh screenshots must confirm the connection action fits.

User-requested outage repair: merged claude/trusted-office-service-keys, commit
72ff926d, preserving its provenance. ADR-146's credential-free office admission
now coexists with normal verification of presented service keys. Worker-only
internal keys remain refused outside /v1/internal/*. All eight trusted-office
regressions passed. Before deploying, a GET of the selected task from the active
Docker worker with its configured service key returned 401; no credential or
response body was copied into evidence. The same read and negative controls are
required after deployment. This check does not dispatch or notify a requester.

The deployed 44af7cc0 restores the real worker service-key GET (200) and keeps
wrong/missing/internal-only task credentials at 401. Its live browser check
exposed another boundary: the office's one-use SSE ticket carries a server-side
marker, which normal presented-key verification refused. Only an actually
redeemed ticket may use that marker, and it must still meet the office-origin
policy; a bearer header with the marker is refused. Regression tests exercise
issuance, redemption, replay, spoofed bearer and foreign-origin rejection.
Desk now displays access loading while server policy is unknown, rather than
flashing a sign-in form before the no-key office bootstrap resolves.

The live task changed while auditing: its latest run now records transferred
with three previews, while the task has no Canva binding and the account is
unauthorized. This audit did not dispatch that run and does not qualify its
provenance or native result. Desk requires the task binding before showing an
editor action, and labels an unbound transfer as requiring reconciliation.
A negative render check prevents the prior false native-document claim. Candidate
score units vary between legacy critique and v3 deterministic paths, so the UI
shows a recorded raw score without inventing a common /10 denominator.

Final focused checks: office stream/negative controls 23 passed across three
files; minimal entry/session/deep-link/transfer controls 42 passed across three
files. The first loading approach broke session interaction checks (17 failures),
and a subsequent wrapper was stopped when it stalled those checks. Both were
removed. The final change uses SignIn's existing provider query and preserves
expired-session behavior; failed and interrupted logs remain in the repair
evidence directory. The next full gate must include this corrected source.
