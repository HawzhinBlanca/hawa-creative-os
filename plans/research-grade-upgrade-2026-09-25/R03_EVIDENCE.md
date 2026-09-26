# R03 — Source/build/deployment identity

**Date:** 2026-09-25. **Status:** in progress; no deployment was performed by this slice.

## Source problem and decision

The previous `RELEASE_MANIFEST.json` described `hawa-*:latest` images and fixed “pinned” models even though Compose builds local images under different tags and the active Canva pipeline resolves its roles from `packages/domain/src/provider-policy.ts` plus runtime overrides. Its checksum and source hashes did not prove what was shipped. ADR-038 separates a checked-in source candidate from an inspected deployment receipt.

## Implemented slice

- `infra/docker/deploy.sh` refuses a supplied build commit that differs from the clean checkout's HEAD before touching Docker or PostgreSQL.
- Manifest v2 identifies itself as `source_candidate` targeting production. It reports each component's image as **unbuilt**, derives production model defaults from the active provider policy, and hashes the policy plus named prompt and QA sources. The verifier recomputes these from code and rejects a self-consistent JSON checksum that invents an image, model or QA version. Runtime overrides and QA runtime version are explicitly `unobserved` in the source candidate.
- Compose passes that commit to the Core, Desk and Worker Dockerfiles; each final image gets an OCI revision label. The deploy checks the just-built image's immutable ID and label before starting Core/Desk or switching a worker colour.
- After health and privacy checks, the deploy reads the latest applied migration name and checksum from `hawa.schema_upgrades`. `scripts/record_deployment_receipt.ts` inspects the running containers' image IDs, tags and image labels, selects non-secret effective flags and model names from Core's live health response, and writes an owner-only receipt. It refuses mismatched IDs/labels, unknown flags/models, a runtime build stamp different from the checkout, or an applied migration differing from the declared target/source file. The source manifest's migration target is not mistaken for the applied version.

## Verification and limits

- Offline contract and negative controls: 3 files / 10 tests passed, including forged checkout stamp, forged image label, mutable tag in place of immutable ID, wrong Core runtime commit, unknown flags/models, and migration name/hash mismatch. `bash -n`, typecheck and `git diff --check` passed before manifest generation; the full source-manifest verifier is run on the clean commit.
- A read-only `docker compose config --format json` check found that profiled `worker-blue`/`worker-green` are omitted unless `--profile worker` is supplied. The image verifier now resolves both colours with that profile; no containers were built or restarted in this check.
- The real Docker build, container label inspection, applied migration readback **on a deployed candidate**, full prompt version coverage, exact export hash chain, rollback, and full clean-branch release gate remain open. The source candidate and inspected receipt must be linked to task/evaluation evidence before R03 acceptance.

## Release verdict correction

The `58b72e7` source candidate passed the complete test suite: **402 files / 3,019 tests**, with 4 files / 48 tests skipped (`/private/tmp/hawdesign-r03-full-suite.log`). During review, the release script was found to initialize its verdict as `QUALIFIED` even though Gate F could remain unrun, Gates B/G were unconditional passes, and A/C/D/E/H could read prior-candidate evidence. The tracked 2026-09-21 evidence itself has `status: QUALIFIED` and `cleanTree: false`. This is a false admission claim; it is not reused.

The preflight now reports its engineering result separately, marks A–H as requiring current deployed-candidate evidence, and offers `--require-admission` for a strict refusal. A dirty checkout is rejected before generated-file checks, and missing test-summary counts cannot be replaced with fabricated defaults. R27 must implement independent validation of live receipt and gate dossiers; this slice does not confer product admission. The branch still lacks remote tracking, so the full seven-stage preflight cannot yet reach its test stage.

## Traceability evidence-column integrity — 2026-09-25

An R21 fifth/sixth-pass review found that five requirement rows had their new evidence notes appended to `test_id` instead of `acceptance_evidence`. The prior package validator accepted these rows because it checked only that `test_id` started with `TEST-`. The notes were moved into `acceptance_evidence`, leaving each stable ID exactly `TEST-<requirement_id>`. The validator now enforces that exact mapping. A negative control changed `FR-059` to `TEST-FR-059 | misplaced evidence` in the validator's in-memory CSV read and confirmed rejection; all 105 actual requirement rows now have exact IDs. This repairs proof indexing, not runtime model behavior or admission status.

The repair is in sealed source `af910c88267da28b9d637c5c431906375d49b3e0` (seal `9cd65e1`). Blueprint validation passed **773 checks / 0 warnings / 0 failures**, and the manifest verifier passed on the clean seal. The admission assessor still returned `UNQUALIFIED_ENGINEERING`; deployed gate evidence is absent.

## Isolated candidate identity — 2026-09-27

The opt-in full-app rehearsal now stamps Core/worker/Desk images, records their
immutable IDs and labels, captures changed runtime file hashes and internal
network membership, and rejects mismatched labels or externally routed provider
callers. This is a disposable deployment receipt, not the production deployment
receipt or admission gate. See R26_EVIDENCE.md; the clean candidate run is pending
at this implementation checkpoint.
