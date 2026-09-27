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
- **The renderer's KAAE logo default (resolved 2026-09-27):** the renderer drew KAAE's logo whenever a caller passed none, and the v3 judge, canary and critique renders passed none. Now:
  - A render draws only the logo it is handed (`resolveLogoHref`, `render-layout-v2.ts`). With no logo it draws a neutral placeholder; this was KAAE gold before.
  - The v3 pipeline takes the client's logo and photos (`PipelineV3CallOptions.render`, filled by `clientRenderAssetsFor` in `v3.stage.ts`), so the judge scores the design that ships.
  - Tests check that a render never carries another client's logo (`packages/creative/test/renderer-neutral-svg.test.ts`).
- **The video-thumbnail playbook (built 2026-09-27, `packages/creative/src/studio/thumbnail-rules.ts`):**
  - A thumbnail client's stages are all told the playbook through the rules every stage reads:
    - the size it is seen at (168 px wide for 16:9, 180 px for 9:16);
    - the person as the focal point;
    - the hook as the largest text;
    - the copy is never cut;
    - the logo small and in a top corner.
  - Its hard QA adds two checks, both of which the layout can fix:
    - `THUMBNAIL_COVERED_ZONE`: text or the logo under the video-length badge (16:9) or the Shorts/Reels buttons (9:16);
    - `THUMBNAIL_HOOK_TOO_SMALL`: a hook under 9 px tall at listing size, which is 69 px on a 1280×720 canvas.
  - The length of the requester's copy is guidance, never a defect, because the copy is exact.
- **KAAE's persona and palette removed from shared code (2026-09-27).** Each pack now carries a `profile`: who the client is, what it orders and its voice, and only what the office has said. KAAE's profile is the identity the prompts used to hard-code.
  - The layout system prompt names no client. The client comes in the request (`CLIENT:` in the layout generator's user prompt), follows the client's colour rules in every stage's rules, and goes to the judge. The judge's brand fit is scored against that profile; it was "institutional prestige, elegance, academic gravitas".
  - The critic, the image-art prompt and the Canva planner no longer describe themselves as KAAE's or as institutional.
  - Colours come from the client:
    - The layout normaliser repairs contrast from the client's palette (`paletteRepairColours`). It used fixed KAAE cream, navy and a `#C5A059` gold that is not in KAAE's palette.
    - Motif, image-prompt, style and ornament fallbacks are neutral greys.
    - A reference pack without a palette is refused rather than filled with KAAE's.
  - A video-thumbnail client gets no brand ornament (texture or dividers).
  - Guard test: `packages/creative/test/no-client-in-shared-code.test.ts`.
  - Still there on purpose:
    - KAAE hex values used only as points in colour space, to find the nearest colour in a client's own palette. They are never drawn.
    - The KAAE persona in `cost-architecture-v3.ts` `STABLE_SYSTEM_PROMPT_PREFIX`, which no production call sends; only a test and a proof script read it.
- **Deferred:**
  - per-client reference retrieval: the studio and the planner still read `kaae-exemplars.json`, which is harmless while KAAE is the only live client;
  - retiring the v1 KAAE templates (`packages/creative/src/templates/kaae-*`), which serve only the legacy preview;
  - a thumbnail proof set per client, run on its real assets once the office supplies them.

## 4. Alternatives considered

- **Client rows only (database):** routing and formats would be editable in the Desk, but reference packs and logos are files that ship in the image. Two sources would have to agree, and a test cannot check a database it does not have.
- **Keep extending the hard-coded lists:** each client would add another branch to intake, the studio and the Desk. That is how the current state came about.
