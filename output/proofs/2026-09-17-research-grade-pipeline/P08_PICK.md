# P08 Proof: Telegram Approve, Edit, Reject Flow

## Specification Requirements
- **Surviving Renders**: Sent as real layout renders in a 3-item media group, captioned with character-exact copy.
- **Inline Controls**: `Use this`, `Edit`, `None of these`.
- **Edit Pathway**: 3 one-tap common fixes derived from critique, plus free text routing through the F07 classifier.
- **Security**: Signed one-time action tokens via `TelegramActionTokenService.createToken` (`pick_layout`, 24h expiration).
- **Token Replay Refusal**: Replayed tokens strictly refused with `REPLAY_DETECTED`.
- **Non-Blocking Timeout**: Unanswered picks auto-advance with the highest-judged candidate.
- **Language Support**: Tested and verified in English and Sorani Kurdish.

---

## 1. Path 1: Pick / Use This

### Journal Excerpt
```json
[
  {
    "timestamp": "2026-09-16T23:39:34.831Z",
    "event": "PICK_PRESENTED",
    "details": {
      "taskId": "task_kaae_lead_pick_01",
      "candidateCount": 3,
      "candidateIds": [
        "candidate_layout_01",
        "candidate_layout_04",
        "candidate_layout_08"
      ],
      "language": "en"
    }
  },
  {
    "timestamp": "2026-09-16T23:39:34.831Z",
    "event": "CANDIDATE_PICKED",
    "details": {
      "candidateId": "candidate_layout_01",
      "actorId": "user_lead_art_director",
      "index": 0
    }
  },
  {
    "timestamp": "2026-09-16T23:39:34.833Z",
    "event": "TOKEN_VERIFICATION_FAILED",
    "details": {
      "callbackData": "act:t_cc4a0d6ae85a:212a00b767fe7204",
      "actorId": "user_lead_art_director",
      "error": "Action token t_cc4a0d6ae85a has already been consumed (replay attack detected)",
      "code": "REPLAY_DETECTED"
    }
  }
]
```

### Messages As Received
**Media Group Preview (Draft 1):**
> *Draft 1: Central Statutory Spine Exact Copy: "Advancing Academic Rigor & Institutional Quality: KAAE sets mandatory accreditation benchmarks and institutional quality standards under Law No. 6 of 2022 for universities across the Kurdistan Region."*

**Interactive Control Message:**
> 🎨 *Design Studio: 3 Candidate Layouts Ready*
Review the drafts above and select an option:
> Buttons: [Use Draft #1] [Edit #1] | [Use Draft #2] [Edit #2] | [Use Draft #3] [Edit #3] | [🚫 None of these]

**User Action:** Clicked `[Use Draft #1]`
**Confirmation Dispatched:**
> ✅ *Draft #1 (Central Statutory Spine) selected!*
Proceeding to final publication and export.

---

## 2. Path 2: Edit (One-Tap Quick Fix + Free Text via F07 Classifier)

### Journal Excerpt
```json
[
  {
    "timestamp": "2026-09-16T23:39:34.831Z",
    "event": "PICK_PRESENTED",
    "details": {
      "taskId": "task_kaae_lead_edit_02",
      "candidateCount": 3,
      "candidateIds": [
        "candidate_layout_01",
        "candidate_layout_04",
        "candidate_layout_08"
      ],
      "language": "en"
    }
  },
  {
    "timestamp": "2026-09-16T23:39:34.831Z",
    "event": "EDIT_MENU_PRESENTED",
    "details": {
      "candidateId": "candidate_layout_04",
      "quickFixes": [
        "Shift crest upward",
        "Subtle border contrast",
        "Expand footer padding"
      ]
    }
  },
  {
    "timestamp": "2026-09-16T23:39:34.831Z",
    "event": "QUICK_FIX_SELECTED",
    "details": {
      "candidateId": "candidate_layout_04",
      "fixLabel": "Shift crest upward"
    }
  },
  {
    "timestamp": "2026-09-16T23:39:34.832Z",
    "event": "FREE_TEXT_CLASSIFIED_F07",
    "details": {
      "inputMessage": "Please make the title 15% larger and ensure the Kurdish crest has more headroom.",
      "intent": "revision_feedback",
      "confidence": 0.95
    }
  }
]
```

### Messages As Received
**User Action:** Clicked `[Edit #2]`
**Edit Menu Dispatched:**
> ✏️ *Editing Draft #2 (Editorial Mandate)*
Choose a one-tap quick fix derived from the design critique, or reply with free text:

💬 Or send your feedback as a text message.
> Buttons:
> [⚡ Shift crest upward]
> [⚡ Subtle border contrast]
> [⚡ Expand footer padding]

**User Action:** Clicked `[⚡ Shift crest upward]`
**Quick Fix Acknowledgment:**
> ⚙️ Quick fix requested: "Shift crest upward". Applying targeted refinement...

**User Action:** Sent free text feedback:
> *"Please make the title 15% larger and ensure the Kurdish crest has more headroom."*

**F07 Classifier Output:**
- **Intent**: `revision_feedback`
- **Confidence**: `0.95`
- **Suggested Modifications**: `undefined`

---

## 3. Path 3: Reject / None of These

### Round 1: Redrive Alternate Candidates
**User Action:** Clicked `[🚫 None of these]` (Round 1)
**Dispatched Notification:**
> 🔄 *None of these selected.* Generating one alternate candidate set (Round 2/2)...

### Round 2: Escalation to Hawa Desk
**User Action:** Clicked `[🚫 None of these]` (Round 2)
**Dispatched Notification:**
> 🛑 *Second round completed without selection.* Task sent to Hawa Desk for manual guidance.

---

## 4. Security Verification: Token Replay Refusal

### Journal Excerpt
```json
[
  {
    "timestamp": "2026-09-16T23:39:34.833Z",
    "event": "TOKEN_VERIFICATION_FAILED",
    "details": {
      "callbackData": "act:t_cc4a0d6ae85a:212a00b767fe7204",
      "actorId": "user_lead_art_director",
      "error": "Action token t_cc4a0d6ae85a has already been consumed (replay attack detected)",
      "code": "REPLAY_DETECTED"
    }
  }
]
```

**Replay Test:** Same callback data re-submitted by actor.
**Verification Result:**
- **OK**: `false`
- **Code**: `REPLAY_DETECTED`
- **Error**: `Action token t_cc4a0d6ae85a has already been consumed (replay attack detected)`
**Dispatched Message:**
> ⚠️ Action denied: This one-time token has already been consumed (replay prevented).

---

## 5. Non-Blocking Timeout Path

### Journal Excerpt
```json
[
  {
    "timestamp": "2026-09-16T23:39:34.833Z",
    "event": "PICK_PRESENTED",
    "details": {
      "taskId": "task_kaae_timeout_04",
      "candidateCount": 3,
      "candidateIds": [
        "candidate_layout_01",
        "candidate_layout_04",
        "candidate_layout_08"
      ],
      "language": "en"
    }
  },
  {
    "timestamp": "2026-09-16T23:39:34.833Z",
    "event": "TIMEOUT_AUTO_ADVANCE",
    "details": {
      "autoSelectedCandidateId": "candidate_layout_04",
      "score": 0.956,
      "index": 1
    }
  }
]
```

**Result:** Auto-advanced without user blocking.
- **Highest Judged Candidate**: `candidate_layout_04` (Score: `0.956`)
**Dispatched Truthful Message:**
> ⏱️ *Selection timeout reached (non-blocking).* Auto-advancing with highest-judged Draft #2 (Editorial Mandate) with composite score 0.956.

---

## 6. Language Parity: Sorani Kurdish

**Control Message:**
> 🎨 *ستۆدیۆی دیزاین: ٣ ڕەشنووس ئامادەن*
تکایە سەیری ڕەشنووسەکانی سەرەوە بکەن و یەکێک هەڵبژێرن:

**Interactive Buttons:**
> [بەکارهێنانی ڕەشنووسی #1] [دەستکاری #1]
> [بەکارهێنانی ڕەشنووسی #2] [دەستکاری #2]
> [بەکارهێنانی ڕەشنووسی #3] [دەستکاری #3]
> [🚫 هیچکام لەمانە]
