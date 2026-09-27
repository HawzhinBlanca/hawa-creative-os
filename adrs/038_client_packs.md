# ADR-038: Clients Are Data: One Client Pack per Client

**Date:** 2026-09-27
**Status:** Accepted 2026-09-27 by the owner ("start the multi-client foundation").
**Requirements:** FR-007 (client channel mapping), FR-011 (scope lock), FR-017 (Client DNA).
**Changes a foundation:** the single KAAE reference pack (`packages/creative/assets/kaae-reference.json`) that the studio used for every request, and the hard-coded client detection in chat intake.

## 1. Context

The office is adding four clients next to KAAE: ZAR Podcast, Halwest News, Kawa ba Hawlery and Erbil Edition. All four mostly need video thumbnails: YouTube landscape (16:9) and vertical reels or shorts (9:16).

The system was built around one client. The audit of 2026-09-27 found that adding a client meant changing code in several places:

- Chat intake picked the client by matching hard-coded words, for KAAE and four demo clients (`apps/core/src/services/chat-campaign-intake.ts`). A request for any other client came in as "no client named".
- The studio read one reference pack, KAAE's, and refused every other client (`design-studio-service.ts`, `getTaskContext`). The official logo path was KAAE's too.
- The requester's acknowledgement named clients through a hard-coded list, and the format was 4:5 for KAAE and 1:1 for everyone else.

## 2. Decision

Each client is described by a **client pack**: a JSON file in `packages/creative/assets/clients/<code>.json`, validated by `clientPackSchema` (`packages/creative/src/clients/client-pack.ts`). The packs sit under `packages/creative/assets` because that directory ships in the production image and `config/clients` does not.

A pack holds:

- **Identity:** a stable client id (the `hawa.clients` row), the code, and the display names.
- **Routing:** the Telegram chats that belong to the client, and the words that name it.
  - Latin aliases match as whole words.
  - Script aliases match as whole words that may carry a Sorani suffix.
  - Phrases match anywhere.
  - A message that names two clients is not routed. The office assigns it, because a guess would attribute a request, and the brand used to draft it, to the wrong client.
- **Formats:** named presets (`youtube-thumbnail` 1280×720, `story-reel` 1080×1920, `social-portrait` 1080×1350, `social-square` 1080×1080, `landscape-hd` 1920×1080) and the default for a request that names none.
- **Playbook:** the kind of design the client mostly orders. At present this is `institutional-announcement` or `video-thumbnail`.
- **Reference:** the verified reference pack and official logo, as asset paths, or `null` until the office has supplied them.
- **Status:** `live` or `onboarding`, and for an onboarding client the list of what is still missing.

Brand DNA (palette, type, rules) stays where it is: the versioned Client DNA rows (FR-017) that the office edits in the Desk. The pack does not copy it.

Rules enforced by the loader, with tests:

1. Every pack validates against the schema. A `live` pack has a reference pack and logo that exist, and nothing listed as missing.
2. Ids, codes, aliases and Telegram chat ids are unique across all packs. A duplicate is a load error, not a silent winner.
3. The reference pack's recorded client id is the pack's id.
4. The logo checksum recorded in the reference pack matches the logo file.

Behaviour:

- **Intake:** a chat bound to a client routes to it before any word matching. Otherwise the packs' aliases are tried. The four legacy demo clients keep their existing detection until they are retired, so nothing that routes today changes.
- **Onboarding clients:** a request routes to the right client and is saved. No automatic draft is started, and the requester is told the client is still being set up and the art director will design it. The studio refuses such a client with `CLIENT_REFERENCE_REQUIRED`, naming what is missing.
- **Studio:** the reference pack and logo come from the task's client pack. KAAE's are the same files as before.
- **Database:** Core makes sure every pack's `hawa.clients` row exists at start-up. It inserts only rows that are missing and never changes an existing row.

## 3. Consequences

- Adding a client is a pack file and, once the office supplies them, the brand assets. There is no code change.
- The four new clients start as `onboarding` with an empty reference. Their Kurdish and Arabic aliases and Telegram chats are left empty on purpose:
  - Kurdish spellings are not guessed. "هەڵوێست" and "زار" are also everyday words, and the repo already routed a Ministry of Health request to Drustee through a common word.
  - The office fills these in as part of onboarding.
- To go live, a client needs:
  - its logo, and its colours and fonts in the Desk DNA screen;
  - a verified reference pack of 15–30 approved past designs;
  - its Telegram chats and main language;
  - a passing proof set across its formats, including Sorani and Arabic copy where the client uses them.
- **Blocks the second live client:** the renderer draws KAAE's logo whenever a caller passes none (`resolveLogoHref`, `packages/creative/src/studio/render-layout-v2.ts`), and the judge's preview renders pass none (`pipeline-v3.ts`). While KAAE is the only live client this cannot leak, because the studio refuses every other client. It must be removed, with a test that a render for one client never carries another's logo, before a second pack is set `live`.
- **Deferred (phase 2):**
  - a thumbnail playbook for the design stages (a face cut-out, a 3–5 word hook, a timestamp-safe corner);
  - a check that the design is still legible at about 170 px wide;
  - removing KAAE's persona, palette and templates from shared creative code;
  - per-client reference retrieval.

## 4. Alternatives considered

- **Client rows only (database):** routing and formats would be editable in the Desk, but reference packs and logos are files that ship in the image. Two sources would have to agree, and a test cannot check a database it does not have.
- **Keep extending the hard-coded lists:** each client would add another branch to intake, the studio and the Desk. That is how the current state came about.
