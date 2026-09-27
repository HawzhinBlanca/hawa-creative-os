# Import language provenance — source correction

Requirements FR-034/035/036. See the R19 locale proof for exact source hashes and limits.

- `red.json` / `red.log`: 12 expected failures before the fix.
- `focused.json` / `focused.log`: 76 passing assertions; one Core test suite failed to load an undeclared test dependency.
- `final-focused.json` / `final-focused.log`: all eight files, 81 tests passed after correcting the test import.
- `persisted-languages.json` / `persisted-languages.log`: 36 planner tests passed including a new explicitly labelled Desk-copy persistence case. There are 82 distinct passing tests across the two final runs.

Run the eight focused files with `pnpm exec vitest run packages/creative/test/transfer-locale.test.ts packages/creative/test/editable-transfer-rtl.test.ts packages/creative/test/transfer-v2.test.ts packages/creative/test/transfer-tracking.test.ts packages/creative/test/r08-transfer-fidelity.test.ts apps/core/test/transfer-locale.test.ts apps/core/test/canva-design-planner.test.ts apps/core/test/design-studio-orchestrator.test.ts`. Build `@hawa/creative` first. DB tests use the isolated test server and fake external providers.

No real Canva import/export, full regression, deployment, human review or message was performed for this correction. Production and the previous isolated candidate remain on their earlier images.
