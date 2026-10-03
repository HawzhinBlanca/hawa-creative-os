# Brief phrasing fuzz (2026-10-03)

- **Harness:** `apps/core/test/brief-phrasing-fuzz.test.ts`, seed 20261003. It is deterministic and runs in about 14 s.
- **Code under test:** `claude/release-3` @ `20ca0671`, which includes the client-as-addressee fix.
- **Raw data:** `violations.json`. It has one row per brief, with the observed copy, title, client, extraction method and violations. Every run rewrites it.

## Method

The harness builds 428 briefs: 380 English briefs from seeded combinations, plus 48 Sorani briefs. The Sorani briefs reuse only lines that already exist in the repository's tests. The English combinations draw on these parts:

| Part | Variants |
|---|---|
| Openings | none; hi, hello, salam; good morning/afternoon; "dear team"; "hey guys" |
| Request verbs | could you make/design/do; can you create; can we get; can I have; please make; we need; I'd like; we want; make me; pls make; can u make; bare "need" |
| Deliverables | poster, flyer, Instagram post or story, story, banner, invitation card, certificate, social media post |
| Events | 17 names, a quarter of them lower case, with or without "our", "the" or "the upcoming" |
| Details | 8 date forms, plus times, venues and audiences |
| Closings | thanks; thank you so much; many thanks; regards + name; best regards + name on the next line; cheers |
| Client mentions | none; "a KAAE poster"; "KAAE's <event>"; "KAAE <event>"; "a poster for KAAE …"; a trailing "It's for KAAE." or "This is for KAAE."; the full English name; "For KAAE, could you …" |
| Layouts | one sentence; request then a details sentence; request line then copy lines; bullets; quoted copy; event first then "make a poster for it"; casual chat with no punctuation |

Each brief goes through the real `/v1/internal/telegram/intake` route. The run uses the real test Postgres and the worker token, with `requesterIntentModel: null` and no OpenAI key. Each brief comes from its own office member in a private chat. When the bot asks "who is this for?", the harness answers "KAAE", and the copy of the kept brief is checked too.

**Invariants**

- **I1:** every copy line is the requester's own words, allowing for whitespace, the ADR-235 first capital and the " · " joiner.
- **I2:** no copy line is a greeting, a thanks or sign-off, a request phrase, a deliverable, the client's name alone, a dangling fragment, or a typed list mark.
- **I3:** the title is non-empty and at most 60 characters after its label. It names the event, with no greeting, thanks or request words, and is not only the client. It does not start with a list mark, end on a dangling word, or get cut when the event's name would fit.
- **I4:** the event's name appears on some copy line.
- **I5:** a brief that names KAAE opens for KAAE. A brief that names no client gets the "who is this for?" question.

## Results

240 of the 428 briefs violate at least one invariant, with **490 violations** in total. These numbers are pinned as the ratchet baseline.

| Invariant | Violations | Main codes |
|---|---:|---|
| I1 own words | **0** | Nothing the requester didn't type was ever printed |
| I2 bad copy line | 232 | thanks or sign-off 77; list mark 70; client alone 66; greeting 11; request phrase 8 |
| I3 title | 185 | misses the event 70; ends on "Is" 51; request words 23; cut 13; list mark 10; greeting 9; client only 6; deliverable 3 |
| I4 event on a line | 32 | every case opened with no copy |
| I5 client | 41 | full English name not recognised 32; question skipped for briefs read as instruction-only 9 |

**The known "For KAAE, could you …" class is fixed at 20ca0671.** Before the fix, 9 of the 10 briefs that open with "For KAAE," printed "For KAAE". After it, none do, and the harness asserts that this stays at zero.

## Root-cause classes, ranked by frequency × severity

Severity weights: **3** = a wrong line would be printed; **2** = the brief opens with no copy or badly shaped copy (no auto-draft); **1** = only the title or the routing is wrong.

### 1. Closings and sign-offs printed (73 briefs, severity 3)

Three cases leak:

- **Sender's name after "Best regards,":** 27 of 30 briefs printed the name.
- **"Many thanks!":** 20 of 24 printed it.
- **Closing glued to the last detail with no punctuation:** printed about 60% of the time.

| Brief | Observed copy | Expected copy |
|---|---|---|
| `…Book Fair on 5 November?⏎Best regards,⏎Ahmed` | `Book Fair on 5 November` / **`Ahmed`** | `Book Fair on 5 November` |
| `…Book Fair on 5 November? Many thanks!` | `Book Fair on 5 November` / **`Many thanks`** | `Book Fair on 5 November` |
| `Please make a poster for the Science Camp on 20 March 2027 thanks` | **`… 20 March 2027 thanks`** | `Science Camp on 20 March 2027` |

**Likely code:**

- `request-copy-extraction.ts`: `EN_INSTRUCTION` (l.146) has no "many thanks"; `sentences()` (l.195) turns the line break after "Best regards," into its own sentence; `withoutChat` (l.495) misses a closing with no punctuation before it.
- `chat-campaign-intake.ts`: `speaksToTheDesigner` misses "Many thanks!".

### 2. A sentence naming the client printed (60 briefs, severity 3)

These phrasings are printed as copy:

| Phrasing | Printed in |
|---|---:|
| "It's for KAAE." | 12/14 |
| "This is for KAAE." | 8/11 |
| "For KAAE please." | 9/13 |
| "It is for the Kurdistan Accrediting Association for Education." | 31/46 |

For example, `…Book Fair on 5 November? It's for KAAE.` prints `Book Fair on 5 November` / **`For KAAE`**.

**Likely code:** `request-copy-extraction.ts` `ruleCopy` (l.505) keeps every non-instruction sentence after the request. `withAddressee` only extends the request's own sentence.

### 3. "with these details:" and list marks printed (60 briefs, severity 3)

- **With a greeting line before the request:** 47 of 55 briefs. The tail "with these details" or "with this text" becomes the headline and the title. For example, `Hi team,⏎can u make a post with these details:⏎- Nawroz Celebration⏎…` is titled **`KAAE: With these details`**.
- **With no greeting:** laid-out blocks keep their "- " marks and the title becomes `KAAE: - Research Day`. On the rules path, "*" bullets are printed (24 briefs).

**Likely code:**

- `request-copy-extraction.ts` `EN_DESIGN` (l.112) has no "with (these|the following) details / this text / for this:" tail.
- `ruleCopy` bullets.
- Laid-out blocks in `chat-campaign-intake.ts`.
- `copyTitle` and `titleName` don't strip list marks.

### 4. "<Event> is on <date>. Make a poster for it." (51 of 54 event-first briefs, severity 2)

| Brief | Observed copy; title | Expected |
|---|---|---|
| `Hello, our Open Day is on 5 November. Could you make a poster for it?` | **`Our Open Day is on 5 November`**; title **`KAAE: Our Open Day Is`** | `Open Day` / `5 November` |

**Likely code:**

- `GLUE_START` (l.472) only covers "it's / this is on".
- `request-title.ts` `titleName` (l.170) cuts before " on " and leaves the copula.

### 5. Short briefs read as instruction-only (32 briefs, severity 2)

**Triggers:**

- "Hi pls make…"
- "Hello We'd like…"
- numeric dates (15/10/2026)
- "next Thursday"
- "Nov. 5"
- a last line of only a city and year ("Erbil, 2026"; 8 of 11 Sorani briefs ending this way)
- a request with no details

**Result:** no copy, no auto-draft, and no "who is it for?" question when no client is named. The question's gate is `!instructionOnly` at `lifecycle-internal.routes.ts` l.1037-1038 (9 briefs). Titles come from the request words (16 briefs).

**Likely code:**

- `requester-turn.ts` `readIntentByRules` (l.956). `complete` relies on `carriesBriefCopy` and `DATE_OR_TIME`, which miss numeric, relative, abbreviated and year-only dates.
- `telegram-classifier.ts` `hasDesignKeyword` (l.302) misses "post" and "story".

### 6. Residue of the addressee fix (14 briefs, severity 3)

- **Name followed by more words:** "for KAAE please" and "for KAAE with these details" are still printed.
- **Sorani spelling of KAAE:** printed as the headline and title (5 of 12 briefs). It exists only in the pack's `routing.phrases`, which `clientNamesFor` doesn't read.

**Likely code:** `addresseePatterns`, `withAddressee` and `clientNamesFor` in `request-copy-extraction.ts`.

### 7. Greeting glued to an event-first sentence (11 briefs, severity 3)

`Hello Our Open Day is on 5 November. …` prints **`Hello Our Open Day is on 5 November`**. With a comma ("Hello, our …"), the greeting is dropped.

**Likely code:** `withoutChat` / `CHAT_CLAUSE` (l.486-495).

### 8. KAAE's full English name not recognised (32 briefs, severity 1)

"…for the Kurdistan Accrediting Association for Education" makes the bot ask "Who is this design for?".

**Likely code:** `kaae.json` `routing.latinAliases` only lists "kaae", "accreditation" and "university". `names.en` isn't used for routing (`client-pack.ts`, around l.180).

### 9. Month abbreviations with a period split sentences (10 briefs, severity 3)

| Brief | Printed lines |
|---|---|
| `…Open Day? It's on Oct. 20 in the main campus.` | `Open Day` / **`Oct`** / **`20 in the main campus`** |
| `…Book Fair on 5 Nov. 2026?` | **`Book Fair on 5 Nov`** / **`2026`** |

**Likely code:** the abbreviation look-behind in `sentences()` (l.197) has no month abbreviations.

### 10. Bare "need a …" with no subject is not read as a request (8 briefs, severity 3)

`need a poster for the Book Fair on 5 November.` prints the whole message, and the title becomes "need a poster for the Book Fair".

**Likely code:** `EN_ASK` (l.98-102) only accepts need/want after "we" or "I".

### 11. Long one-sentence brief loses all its copy (2 briefs, severity 2)

When the rules headline is longer than `MAX_HEADLINE` (110), `grounded()` (l.563) refuses it, so the extraction method is `none` and the brief goes to a designer.

## What held

- **I1 is 0:** nothing the requester didn't type was ever printed.
- **Clean cases:** quoted copy, Sorani test sentences, and a request followed by a details sentence (where the closing is its own sentence) are almost always clean.
- **The 20ca0671 fix holds** for every "For KAAE, …" variant.

## Reproducing

```bash
pnpm test:db
npx vitest run apps/core/test/brief-phrasing-fuzz.test.ts   # rewrites violations.json; fails if any count rises
```

When a fix lands, lower `BASELINE` in the test to the new counts. Never raise it.
