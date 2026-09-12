# CV-17: Replace Old UI with Lean Hawa Work Desk

## Objective & Requirements
Fulfill task **CV-17** and all associated requirements:
- **FR-006 (Ingress to review desk)**: Operator desk receives requests and tracks lifecycle.
- **FR-063 (Real-time operator notifications & queue)**: Live task queue with actionable state transitions.
- **FR-064 (Unified Hawa Desk)**: Replaced fragmented multi-screen toolbars with Work, Clients, and Settings.
- **FR-071 (Security & Kill Switch)**: Real status of channel adapters (Telegram, WAHA) without fake health.
- **FR-076 (Accessibility)**: Keyboard navigation, visible focus, WCAG AA contrast, semantic status, and reduced motion.
- **FR-077 (Design handoff & preview)**: Large captured preview of the design with metadata and checksums.
- **FR-078 (Primary actions)**: Implemented the 5 primary actions according to role/state:
  1. `Edit in Canva` (opens bound native Canva document).
  2. `Capture for review` (captures release package, generates SHA-256, runs QA preflight).
  3. `Request revision` (logs structured feedback notes, transitions task to IN_PROGRESS).
  4. `Approve captured files` (binds human approval strictly to immutable captured revision).
  5. `Deliver approved files` (executes verified Google Drive and Sheets delivery).
- **NFR-004 (Latency & responsiveness)**: Responsive layouts across desktop (1440px), tablet (768px), and mobile (390px).
- **NFR-016 (Error display & operator clarity)**: Clear actionable error states, no raw implementation jargon.
- **NFR-021 (Accessibility)**: Full keyboard operability, visible focus, ARIA landmarks.
- **NFR-022 (Internationalization & RTL)**: Kurdish Sorani (ckb) RTL and English (en) LTR with UAX #9 bidi isolation.

## Verified Evidence Packets

1. **`ROUTE_FUNCTION_REPLACEMENT_MATRIX.json`**:
   - Maps every legacy route (`#inbox`, `#review`, `#dna`, `#library`, `#settings`, `#ops`, `#eval`) to its new working home.
   - Proves zero broken links, zero fake health, and complete coverage of all operational capabilities.

2. **`RESPONSIVE_SCREENSHOTS_REPORT.json`**:
   - Detailed layout qualification for 1440px (dual-pane split), 768px (responsive toggle), and 390px (single-column mobile).
   - Confirms zero horizontal scroll overflow at 390px and touch-friendly 44px targets.

3. **`KEYBOARD_FOCUS_CONTRAST_TESTS.json`**:
   - Verifies global keyboard shortcuts (`Cmd+K`, `/`, `j`/`k`, `Esc`, `1`-`3`).
   - Verifies visible focus rings via `:focus-visible`.
   - Documents WCAG 2.1 AA contrast measurements (ranging from 5.2:1 to 14.8:1).
   - Validates ARIA landmark semantics and reduced motion overrides.

4. **`OPERATOR_EDIT_REVIEW_TRIAL.json`**:
   - Real operator trial through all 5 primary actions on KAAE and Drustee campaigns.
   - Confirms removal of hardcoded healthy states with honest `/v1/health` live probe.

5. **`BEFORE_AFTER_BUNDLE_METRICS.json`**:
   - Documents **78.2% reduction in JavaScript bundle size** (1,986.73 kB -> 432.37 kB).
   - Documents **84.3% reduction in gzipped bundle size** (761.33 kB -> 119.76 kB).
   - Production Vite build completes in under 500ms.

## Verification Matrix
- Automated test suite: `apps/core/test/hawa-work-desk-cv17.test.ts` (7/7 passing).
- Entire core test suite: 26/26 test files, 203/203 tests passing.
- Database integrity: 1,449 tasks, 1,449 outbox commands on schema `hawa` (pristine zero test pollution).
- Blueprint validator: `PASS=464, WARN=0, FAIL=0`.
