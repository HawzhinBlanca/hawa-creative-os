# Why Sewa got no design, why feedback is not applied, and why the last ten designs are the same (2026-09-16 12:20 Baghdad)

Lead re-execution on production: Telegram inbox events, outbox commands, Canva plans and bindings,
Restate invocation journals, Telegram bot state. Identifiers are masked; no message text beyond what
the user already knows is reproduced.

## 1. Sewa's request

| Time (UTC) | Message | What the system did | What Sewa was told |
|---|---|---|---|
| 09-13 14:12 | full KAAE invitation request | task `5bb1bc17…`; two plans failed `MODEL_HTTP_401`; a Canva design `DAHVFo4pV14` was bound one second later | a draft link (that day's flow) |
| 09-15 11:48:28 | "Djdj" (a typo) | became a task `f001197f…` with no client; workflow returned `MANUAL_DESIGN_REQUIRED` in 11 ms **without any notification step** | only the intake acknowledgement "Brief received and queued in Hawa Desk" |
| 09-15 11:48:31 | full KAAE invitation request | task `5f94e0e3…`, auto-generation on; planner call to the model failed **`MODEL_HTTP_400`** (the Anthropic account had no credit; the OpenAI switch came five hours later); workflow `DESIGN_FAILED`; journal step `canva-notify-design_failed` completed with `notificationSent: true` | "Request saved, manual design (MODEL_HTTP_400). Your request is saved and the art director will design it in Canva." |
| since then | nothing from Sewa in the inbox | no retry, no re-drive after the provider was fixed, no operator action | nothing |

So Sewa did receive an answer on 09-15: a failure notice that promised manual design. Nobody
designed it. The system has **no re-drive of failed requests** once the provider is back; a failed
request is a dead end unless the art director notices it in Desk. Her request is one of the 13 failed
plans on the KAAE client. That is the real "no answer".

Telegram plumbing is otherwise healthy: bot polling active (no webhook set, 0 pending updates), the
allowlist contains two senders and Sewa is one of them, all recent updates reached the inbox.

## 2. Why feedback is not applied

Traced on the user's own messages this morning (all one chat):

| Time (UTC) | Message | Classification | Result |
|---|---|---|---|
| 07:44 | "can you make it look better more high end and professional" | revision (regex hit "better") | new task, `bilateral_grid`, same skeleton → `DAHVV7jusxc` |
| 07:45 | "thats the same design again" | revision ("same design") | same skeleton → `DAHVV9L0VIY` |
| 07:46 | "change the whole design, thats really bad, looks basic and cheap" | revision ("change") | same skeleton → `DAHVV23EF_8` |
| 08:52 | "create a new one better, best one u can" | revision ("better") | same skeleton → `DAHVWKcpVec` |
| 08:56 | "the background is simple and solid, i want some kind of gradient or texture…" | **not** a revision (no keyword matched: gradient, texture, background are not in the list) | **treated as a brand-new brief; the feedback sentence became the only copy block; a Canva design `DAHVWDIQj7s` was produced whose headline is the feedback sentence**, delivered with "font mismatch" status |

Three mechanisms make feedback ineffective:

1. **Revision intent is a keyword list.** `app.ts` decides "is this feedback?" with a regex of ~40
   English words. Anything phrased differently is a new brief, and the whole message is set as the
   design copy. Sewa's or anyone's feedback about texture, gradient, spacing, photo, colour, size,
   logo, "make it like the first one" and most Kurdish phrasing falls through.
2. **Revisions are forced to keep the layout.** A recognised revision creates a child task with
   `Operator Revision Directive: <text>`; the planner then (a) runs `resolveLayoutArchetype`, which
   returns `bilateral_grid` for any client with a prior plan, and (b) sends the previous layout as an
   assistant turn with the instruction "retain all unmentioned elements, coordinates and copyIndex
   bindings… execute the adjustments incrementally". "Change the whole design" is executed as a
   small incremental edit of the same twin-card grid. The same skeleton is guaranteed by design.
3. **The prompt dictates the geometry** (see the architecture verdict of this morning): mandatory
   cards, plinths, bar sizes and frame rules with literal coordinates. Feedback cannot override what
   the system prompt makes mandatory.

The user's 09-15 21:21–21:25 messages show the same loop: "thats the earlier design. make a new one
better" three times → three revision tasks → three bilateral grids.

## 3. Why the last ten designs are the same

Production plans for KAAE since 09-15 17:33 UTC: ten plans, ten times 11 shapes and 8 text boxes;
every plan after the archetype code landed is `bilateral_grid`. Causes, in order of weight: the
archetype lock (`priorPlanCount > 0`), the "retain everything" revision prompt, the coordinate-level
geometry in the system prompt, and one admitted font that Canva swaps for Arimo. GPT-6 Astra is
better outside the app because outside the app nobody hands it a fixed skeleton and forbids change.

## 4. Other findings from the same trace

- Nine of the last ten designs are revisions of one brief created by five messages in one chat; each
  cost a model call and a Canva import. The per-sender daily cap is 5 auto-generations; the sixth
  request today will be saved for manual design and the sender told so.
- A message with no recognisable client ("Djdj") becomes a task and the workflow exits without any
  notification; the sender only sees the generic acknowledgement.
- 17 outbox commands are dead-lettered (all 09-14 synthetic audit tasks; not user requests).
- Health reports `modelProvider: connected` regardless of billing; Sewa's failure would look the
  same today if the OpenAI balance ran out.

## 5. Fixes, in order (implementing agent unless marked)

1. **Re-drive failed requests.** Add an operator action (Desk button and `/redo <taskId>`) and a
   daily sweep that re-plans `failed`/`uncertain` plans once a real provider probe passes; message
   the requester when it starts and when it lands. Run it now for Sewa's `5f94e0e3…` and the other
   12 failed KAAE plans.
2. **Feedback classification by the model, not by regex.** Every message from a chat with a task in
   the last 48 h goes to `gpt-6-astra` with the last design's image and copy: is this a new brief,
   feedback on the last design, or a question? Return structured JSON. Fall back to "ask the sender"
   when unsure, never to "new brief with the feedback as copy".
3. **Revisions must be allowed to change the design.** Remove the archetype lock and the coordinate
   dictation; give the planner the previous render as an image plus the critique, with "change what
   the feedback asks, keep the copy". "Change the whole design" → a new concept, not an incremental
   edit.
4. **Never design with copy that was not a brief.** Refuse auto-generation when the only copy block
   is a single sentence that reads as an instruction (heuristic plus model check), and ask the sender
   to send the copy.
5. **Notify on every terminal path**, including `MANUAL_DESIGN_REQUIRED` and `CLIENT_REQUIRED`, with a
   sentence that says what happens next and who owns it.
6. **Billing-aware health and alerting** (already listed in the OpenAI switch review).
7. **Studio v2 wired to OpenAI with references** (architecture verdict) so that "better" has a
   mechanism behind it.

User: Sewa's request from 09-15 is still undesigned; until fix 1 lands, design it manually in Canva
or reply to her from the office account.

## 6. Evidence

Restate `sys_invocation`/`sys_journal` for `5f94e0e3…` (steps: verify-task-scope, create-draft,
notify-design_failed, `notificationSent: true`) and `f001197f…` (Input → Output only, 11 ms);
`hawa.canva_design_plans` diagnostics `MODEL_HTTP_400`/`MODEL_HTTP_401`; `hawa.outbox_commands`
payloads for `fc602e7e…` (single `exactCopy` block equal to the feedback sentence); plan manifest copy
for `fc602e7e…`; Telegram `getWebhookInfo` (no webhook, 0 pending); `/v1/health` telegram active;
`app.ts` revision regex and `canva-design-planner.ts` `resolveLayoutArchetype`.
