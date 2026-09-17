# TASK: T7 — End-to-end live proof from a real message

## STATUS: BLOCKED ON LIVE BILLING (Flag Scoping Implemented & Tested; Blocked on Provider Credits)

## COMMITS
- Per-Chat Flag Isolation:
  - `apps/core/src/services/chat-intake.ts`: Implemented `DESIGN_PIPELINE_V3_CHATS` environment variable parsing. When global feature flags `DESIGN_PIPELINE_V3=off` and `DESIGN_STUDIO_V2=off` remain enforced for production users, only chats explicitly listed in `DESIGN_PIPELINE_V3_CHATS` (e.g. `7191500129`) receive `designStudio: true` in the task aggregate and outbox command.
  - `apps/core/test/chat-intake-flag-scoping.test.ts`: Added automated verification asserting:
    1. Un-allowlisted chats receive `designStudio: false` when global flags are `off`.
    2. Specifically allowlisted test chats receive `designStudio: true` even when global flags are `off`.

---

## PROOF

### 1. Flag Scoping Automated Test Evidence
```bash
$ pnpm vitest run apps/core/test/chat-intake-flag-scoping.test.ts
```
Output:
```
 ✓ apps/core/test/chat-intake-flag-scoping.test.ts (2 tests) 33ms
   ✓ T7 Flag Scoping: DESIGN_PIPELINE_V3_CHATS (2)
     ✓ keeps designStudio disabled for un-allowlisted chats when global flags are off (13ms)
     ✓ enables designStudio for specifically allowlisted test chat even when global flags are off (7ms)

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### 2. Live Execution Pre-Condition & Billing Block
The task sheet explicitly notes:
> "**Do:** with credits restored and flags enabled for one test chat only, send a real Telegram brief and carry it all the way through to a Canva link, then send a revision and carry that through too."

At present, OpenAI API credits remain exhausted on the provider account:
```bash
$ curl -s https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
```
Response:
```json
{
    "error": {
        "message": "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
        "type": "insufficient_quota",
        "param": null,
        "code": "credit_balance_exhausted"
    }
}
```
When a message arrives over Telegram with `designStudio: true`, the pipeline initiates `gpt-6-astra` layout generation. Because credits are exhausted, the provider immediately refuses with HTTP 429.

Per `synthesis/how-hawzhin-works.md` ("When a task is genuinely blocked on something only he can do — sudo, billing, a subjective listening call — say so explicitly and separately, rather than burying it"), this live execution boundary is reported truthfully to the owner.

---

## LIVE IDS
- Test Chat ID: `7191500129` (KAAE Primary Operator channel)
- Production Database: `hawa` on port `54332`
- Historical Authentic Binding: Task `9fc00562-f631-4953-a1f8-e5eb0b90dc0c` -> Canva Design `DAHVdVy1ENg`

---

## DEVIATIONS
- None in implementation. The per-chat flag isolation is implemented in code and verified with unit tests. Live message generation is gated on restoring API credits.

---

## WHAT I DID NOT DO
- Did not turn `DESIGN_PIPELINE_V3=on` globally for all chats.
- Did not fabricate synthetic Canva design links or simulated Telegram responses.
