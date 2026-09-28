# ADR-089 — Complete and honest test type verification

Date: 2026-09-27
Status: Accepted; compiler and runtime verification recorded in R01_TEST_TYPE_GATE_PROOF.json
Requirements: NFR-012, NFR-024; AI_BUILD_PROMPT Phase 0A; research G0/R01

The old test compiler wrapper ignored its subprocess error and accepted output
without a diagnostic matching `/test/`. The config also excluded all Core and
Worker tests and many active suites. Direct compilation failed while the wrapper
reported success. An expanded strict inventory exposed 427 errors in 83 files,
including malformed mocks, stale fixtures and a missing declared browser runner.

Preserve the selected strict TypeScript foundation. Compile every active test
root and its dependencies, and fail on any compiler/configuration/process error.
Do not filter diagnostics by path or infer success from text. Use the installed,
pinned compiler through Node, without npx fetching an absent executable. Check
inventory coverage independently of the tsconfig include/exclude declarations.
Browser tests use the Desk's bundler module-resolution semantics; Node tests keep
NodeNext. Neither profile substitutes for running its tests.

Repair fixtures and give mocks their real boundary signatures. Keep runtime
negative inputs explicit and checked with narrow intentional casts where needed;
do not weaken production contracts or add broad any/ts-ignore suppressions merely
to make tests compile. Do not delete, skip or exclude failing active suites.

Real compiler failure fixtures must prove rejection of imported-source errors,
config errors and missing compiler execution. A complete root inventory and clean
compilation are required before declaring the gate repaired. Browser dependency
installation is justified by the existing test:e2e command and test imports; pin
the version and do not claim native browser execution from type checking.

Implementation preserves runtime compatibility while making existing contracts explicit:
retrieval conflicts now provide canonical type/sourceIds/message alongside their
existing metadata; inline base64 model-image data is declared instead of cast to
any. Tests use actual HTTP adapters with deterministic transport where generic
mock methods previously lied about their result type. Obsolete publisher hooks
were removed because the suites already use the isolated Drive/Sheets HTTP server.
Fixture repairs preserve assertions; historical malformed JSON remains explicitly
identified where a regression intentionally checks backward compatibility.

Independent discovery scans the repository rather than a fixed directory list,
so a new test directory cannot silently evade coverage. The 479 current roots
compile strictly; the new-directory negative control and final recovery drill
are recorded separately from the full regression. No browser session or live
provider/production admission is implied by these checks.
