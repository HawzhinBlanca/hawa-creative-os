# Requester-reviewed Telegram PDF and voice sources

Date: 2026-09-27 · ADR-073/075 · R07/R12/R20 · current studio contract: Canva

## What this path admits

A PDF with native extractable text, at most 20 MiB and 40 pages, from an allowed
sender in a lifecycle-enrolled chat. The original is retained before extraction.
Telegram must identify it as `application/pdf`; a filename alone does not choose
PDF extraction. Ambiguous image/document uploads retain the existing byte-verified
image or unsupported-file path; resend a held PDF with its correct document type.
The parser is local and bounded. OCR, image interpretation and table reconstruction
are not admitted by this path.

Voice/audio messages must contain a single-stream Ogg Opus recording, at most
20 MiB and ten minutes of encoded audio. Container checksums, packet timing and
duration are inspected locally; Telegram's declared duration is not trusted. This
is a structural/timing check, not acoustic decoding or a transcription-quality
claim. Other codecs and mixed media are held; a caption cannot replace unread audio.

Retaining, extracting or confirming request copy does not approve a design,
publication, Client DNA or reference-search knowledge. Office review remains in Desk.

## New design

Send the original PDF or Ogg Opus audio file with this caption, substituting the
registered client code. Use an audio-file upload when the Telegram voice-note UI
does not offer a caption:

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

After the saved-source notice, inspect every PDF page or listen to the complete
recording. Correct factual words, numerals and punctuation in any transcript.
Reply to **your original source message**, in the same chat/topic and from the same sender, with:

```text
/use_source
The exact corrected text to print.
```

Only the command line is removed. Every subsequent space, line break, underscore,
punctuation mark and script is part of the requested copy. Do not append instructions
to this confirmation; put instructions in the source caption. The preview is shortened
when necessary and is not a substitute for reviewing the whole original.

A successful confirmation starts the existing request lifecycle once. A second
confirmation cannot create another request from that source. Use the existing
request's revision flow for later changes.

## Revision or clarification

Reply with the PDF or voice/audio message to the request's **latest**
revision/clarification notice. A voice note in this exact reply can inherit the
request's client and format without a caption. The
saved source captures that request, task and expected revision. It keeps the
request's client; a conflicting Client caption is refused. Then confirm the copy
by replying to that source message as above. Confirmation replaces factual design copy with
the reviewed strings and retains the earlier request requirements. A stale request
notice or confirmation never silently becomes a new request.

## Inspect and recover in Desk

In the client's PDF inspection section, select **Browse Telegram sources**. The latest
20 retained sources show one of these states:

- Original saved; extraction pending.
- Ready for copy review.
- Requester copy reviewed (this does not mean design approval).
- Extraction stopped; original available.

Download the retained original even when extraction failed. Open available extracted
text for inspection. For voice, **Inspect transcription** shows the full escaped,
unreviewed transcript when available, locally inspected duration, reserved estimate
and unknown actual billed cost. Download the retained audio to listen to it.
Sources and task attachments require current client access;
revoking that access prevents subsequent reads. Missing or damaged bytes return an
unavailable error rather than an unverified file.

A PDF parser outage or unavailable source download returns a retryable result. The worker's
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


## Voice policy, budget and recovery

Cloud transcription requires all of the following at the durable admission boundary:

- An active client and currently effective, explicitly approved active Client DNA.
- Both client policy and DNA authorize external processing; DNA allows `openai`,
  and any client-level provider allowlist also includes it.
- A current tenant-scoped `voice_transcriber` deployment for `openai` / `whisper-1`,
  admitted as primary or the sole eligible canary, with a deployment version.
- An explicit numeric deployment `policy_profile`: `usdPerMinute` (0.006–1),
  `maxUsdPerCall`, `dailyUsdBudget`, and a positive integer `maxCallsPerDay`.
- A configured provider credential, kept outside source and evidence files.

The reservation rounds validated encoded duration up to whole minutes. Hard ceilings
are $0.10 per call, $1 per UTC day per tenant and 1,000 calls per day; configured
lower limits apply. These are conservative reservations, not actual charges.
Rejected and uncertain attempts continue to consume the reservation. No deployment,
model evaluation, credential or cloud admission is created by the migration.
A missing policy, model, credential or budget leaves the original available for
manual copy review and makes no provider request.

One paid attempt is allowed per tenant/client/audio hash. Its policy, model and
reservation commit before dispatch; its first outcome is retained separately.
Concurrent delivery, replay or another message containing the same audio cannot
start a second call. A lost response or crash without a saved outcome stays uncertain.
Use original audio for reviewed copy and reconcile the call with provider records;
there is no automated retry, refund or billing-settlement command in this slice.
A provider request ID is retained when returned in an accepted header shape.

A saved manual decision stays manual for that original update even after policy,
configuration or credentials change. A later confirmation before paid admission
also closes that update to cloud processing. Resending identical audio cannot bypass
an existing paid attempt. Do not delete attempt records to force another call.
Manual `/use_source` confirmation can continue the design request while financial
uncertainty remains; it does not resolve that uncertainty or approve the design.

Legacy Telegram intake still holds unread voice before download. The standalone
`/v1/assets/transcribe-brief` route inspects exact supplied text and returns 412 for
uploaded audio. Durable voice intake belongs to the lifecycle source path above.

### Voice fault verification

```sh
pnpm typecheck
HAWA_VOICE_RECOVERY=1 HAWA_VOICE_PROOF_PATH=/private/tmp/hawa-voice-proof.json \
  pnpm exec vitest run apps/core/test/lifecycle-voice-recovery.test.ts
```

This guarded test uses disposable PostgreSQL on port 55432, temporary storage and
synthetic loopback Telegram/transcription HTTP responses. Five actual Core kills and
six starts check admission, paid reservation, returned response, retained outcome
and exact-copy confirmation. The current proof records 40 passing invariants,
four original downloads and two synthetic transcription requests. Privacy revocation
before paid admission prevents dispatch; an admitted attempt with no outcome is
never retried after restart. This does not prove real speech recognition, provider
billing, production deployment or the full live Canva workflow. See
`R07_VOICE_RECOVERY_PROOF.json` and ADR-075.
