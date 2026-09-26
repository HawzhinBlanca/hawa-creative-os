# Requester-reviewed Telegram PDF sources

Date: 2026-09-27 · ADR-073 · R07/R12 · current studio contract: Canva

## What this path admits

A PDF with native extractable text, at most 20 MiB and 40 pages, from an allowed
sender in a lifecycle-enrolled chat. The original is retained before extraction.
Telegram must identify it as `application/pdf`; a filename alone does not choose
PDF extraction. Ambiguous image/document uploads retain the existing byte-verified
image or unsupported-file path; resend a held PDF with its correct document type.
The parser is local and bounded. OCR, image interpretation and table reconstruction
are not admitted by this path. Voice admission remains separate, unfinished work.

Retaining, extracting or confirming request copy does not approve a design,
publication, Client DNA or reference-search knowledge. Office review remains in Desk.

## New design

Send the original PDF with this caption, substituting the registered client code:

```text
/new
Client: <registered client code>
Size: 1080x1080
Design instructions for the editable layout.
```

One Client line selects an active registered client by code, full name or UUID.
One optional Size line sets width and height in pixels, each between 640 and 2400.
If omitted on a new request, the current 1080x1350 default is displayed in the
review notice. An existing request keeps its format unless the source caption
explicitly supplies Size. Ambiguous/invalid selections are refused before download.
Group messages require `/new` or an exact reply to a current request notice.

After the saved-source notice, inspect every page of the original. Reply to **your
original PDF message**, in the same chat/topic and from the same sender, with:

```text
/use_source
The exact corrected text to print.
```

Only the command line is removed. Every subsequent space, line break, underscore,
punctuation mark and script is part of the requested copy. Do not append instructions
to this confirmation; put instructions in the PDF caption. The preview is shortened
when necessary and is not a substitute for reviewing the whole original.

A successful confirmation starts the existing request lifecycle once. A second
confirmation cannot create another request from that source. Use the existing
request's revision flow for later changes.

## Revision or clarification

Reply with the PDF to the request's **latest** revision/clarification notice. The
saved source captures that request, task and expected revision. It keeps the
request's client; a conflicting Client caption is refused. Then confirm the copy
by replying to the PDF as above. Confirmation replaces factual design copy with
the reviewed strings and retains the earlier request requirements. A stale request
notice or confirmation never silently becomes a new request.

## Inspect and recover in Desk

In the client's PDF inspection section, select **Browse Telegram PDFs**. The latest
20 retained sources show one of these states:

- Original saved; extraction pending.
- Ready for copy review.
- Requester copy reviewed (this does not mean design approval).
- Extraction stopped; original available.

Download the retained original even when extraction failed. Open available extracted
text for inspection. Sources and task attachments require current client access;
revoking that access prevents subsequent reads. Missing or damaged bytes return an
unavailable error rather than an unverified file.

A parser outage or unavailable download returns a retryable result. The worker's
bounded retry/dead-letter handling remains the operator control; inspect the cause
and replay the **unchanged original event** after recovery. Do not create another
request as a substitute for reconciling an uncertain original result. The saved
client choice survives changes to client codes and enrolment flags.

Validation refusals and permanent extraction failures replay their original result.
Correct them with a new Telegram message/update. Renaming clients, enabling a flag,
or changing the contents under the old update ID cannot turn a refusal into work.
A scan requiring OCR needs a corrected text PDF or a separately reviewed manual
request; no OCR fidelity is claimed. Restore a missing original by its verified
hash before proceeding with its existing confirmation.

## Engineering verification

Build workspace packages before running tests that import their compiled exports:

```sh
pnpm typecheck
HAWA_SOURCE_RECOVERY=1 HAWA_SOURCE_RECOVERY_REPORT=/private/tmp/hawa-source-proof.json \
  pnpm exec vitest run apps/core/test/lifecycle-source-recovery.test.ts
```

The opt-in drill uses a guarded disposable `hawa_t_*` database on loopback port
55432, temporary blob/cwd directories, a synthetic authenticated office session,
and the pinned offline Docling image. It exercises the real Telegram downloader
against two fixed local responses. All other child fetch destinations are denied;
the child cannot load the office `.env.local`.

Five actual Core SIGKILLs cover admission, retained bytes, extraction, confirmation
and committed task projection. The expected result is six starts, one download,
one extraction and one task/event/outbox. This is not live Telegram, Restate journal,
Canva export, clean-host restore or independent human design-quality qualification.
Production flags must stay under the broader release admission procedure.


## Voice while admission is unfinished

Send the complete brief as text. Legacy voice messages are held before download,
including messages with captions, because the spoken instructions cannot be assumed
from the caption. No task starts from a partial voice request. The transcription
adapter's candidate output needs explicit copy review and reports unknown confidence,
language and duration honestly; it is not yet a supported durable voice intake flow.
The legacy `/v1/assets/transcribe-brief` route accepts supplied text for inspection,
preserves it without factual normalization, and returns 412 for uploaded audio.
See ADR-074 and R20_VOICE_EVIDENCE_PROOF.json for engineering scope and limits.
