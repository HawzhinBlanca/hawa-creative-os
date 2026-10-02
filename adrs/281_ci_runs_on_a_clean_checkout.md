# ADR-281: CI Gives the Same Verdict as a Clean Checkout

**Date:** 2026-10-03
**Status:** Accepted (branch `claude/ci-green`; CI policy only, nothing deployed)
**Requirements:** NFR-012 (core logic covered by tests), NFR-013 (compatibility suite before upgrades)
**Related:** ADR-118 (Pango text measurement), ADR-141 (tool caches are not package files), ADR-163 (host-local service boundaries), ADR-205 (disposable candidate boundaries)

## Context

`.github/workflows/ci.yml` passed 9 of its last 100 runs, so it could not be a merge gate. Run 36988904615
(2026-10-02, `codex/research-grade-design-system` at c194d994) failed in all three jobs. Every failure was a
difference between the developers' Macs and a clean Linux checkout, not a product defect the suite had
caught:

1. **Gate A.** `plans/lean-design-implementation-2026-09-28/DESK_AUDIT_FIXES.md` linked into
   `output/audits/2026-09-29-product-flow-fixes/`, which is git-ignored. The link resolved on checkouts
   where someone had copied `output/audits` in by hand, so `validate_pack.py` passed there and failed on
   every fresh clone and CI runner.
2. **Gate S.** `docker-compose.prod.yml` makes Core read `.env.service-boundaries` (and the workers
   `.env.worker`). Neither file is committed: `deploy.sh` generates both with
   `infra/ops/prepare_service_boundaries.py`. The CI step created only `.env.production`, so
   `docker compose config` stopped at the missing file.
3. **Gates C–P.** Seven tests failed on the runner:
   - Five upload tests (`asset-source-retention` ×2, `security`, `track-b-gates` ×2 — the last two upload a
     PNG before searching) answered 422 or `spawnSync ffmpeg ENOENT`. Core decodes every uploaded
     PNG/JPEG/WebP with ffmpeg before admitting it (`packages/creative/src/uploaded-asset-inspection.ts`).
     `Dockerfile.core` installs ffmpeg and `libheif-examples`; `scripts/ci/install_render_deps.sh`, which
     says it installs "the same set Dockerfile.core installs", did not. The media-conversion,
     lifecycle-voice and natural-media-intake tests that need the same tools skipped silently.
   - `chaos-service-boundaries` ran `nginx -t` in the pinned production image with `--pull=never`; a fresh
     runner has no images, so `docker run` exited 125. Four other nginx suites (blob-nginx,
     nginx-internal-boundary, nginx-rate-limits, release-directories) skip without the image, so they had
     never run in CI.
   - `gate-modes` timed out at 30 s; the base already carries the 90 s timeout (ADR-273 measurement cost).

## Decision

1. **Gate A refuses a committed Markdown link into a git-ignored path, on every checkout.**
   `validate_pack.py` asks `git check-ignore` about each link target; a link from a document git tracks
   (or would track) into an ignored path fails with "local evidence, not in git: cite the path in prose",
   whether or not the local copy exists. The offending link became a prose path.
   Considered and rejected: reporting such links as a warning. A warning would keep a link that is broken
   for every reader on GitHub and on every clean clone, and the check would still give different verdicts
   on different checkouts. Refusing it everywhere makes the local run predict CI. Where git is absent (an
   unpacked release bundle) the rule cannot be evaluated; the validator warns rather than passing silently.
2. **Gate S generates the boundary files the way a deployment does.** The step copies both example files,
   runs `prepare_service_boundaries.py` (throwaway random values that exist only on the runner) and
   validates every profile (`--profile '*'`), so the worker services' env files are checked too.
3. **The test job installs what production runs.** `install_render_deps.sh` adds `ffmpeg`,
   `libheif-examples` and, where the distribution has it, `libheif-plugin-libde265` (Ubuntu 24.04's
   libheif 1.17 loads its HEVC decoder as a plugin that is only a Recommends; verified in an
   `ubuntu:24.04` container: without it `heif-convert` answers "Unsupported codec"). A workflow step pulls
   the nginx tag `docker-compose.prod.yml` pins, so the nginx tests run instead of skipping.
4. **`blob-nginx.test.ts` works on a native Linux engine.** It pointed nginx at `host.docker.internal` and
   served its stub Core on 127.0.0.1. Only Docker Desktop answers that name and forwards to the host's
   loopback; on a native engine nginx answered 502 (verified with `docker:dind`: 502 before, 200 after).
   On a native engine the stub now listens on the test network's gateway (the host's own address on that
   bridge) and nginx is given that address. Docker Desktop keeps the previous path.

5. **`design-studio-orchestrator` test 5b gets 120 s instead of 25 s.** CI run 37074297042 (the first
   with decisions 1–4) passed Gates A, B, Q and S and fixed all seven earlier test failures, but 5b timed
   out and both 6b cases then chose a different winner. 5b briefs a title no poster composition can carry
   (ADR-271), and proving that measures every candidate size with the text helper: 8 s on an M-series
   Mac, 10.5 s in a native arm64 `ubuntu:24.04` container, about 90 s in an emulated amd64 one, and more
   than 25 s on the 4-vCPU runner. A timed-out Vitest test is not stopped: 5b's body kept running with
   `DESIGN_PIPELINE_V3=on` and its run active, which changed the pipeline the following tests ran. In the
   emulated amd64 container this reproduced exactly (5b timed out, 5c and 6 failed); with 120 s all 20
   tests passed there, natively in arm64 and on the Mac. The 6b assertions are unchanged.
6. **Every change past a release seal needs a new seal.** `r11-release-gate` test 1 refuses a tree whose
   files differ from `RELEASE_MANIFEST.json`'s build commit (run 37074297042 failed it for that reason, by
   design). This branch therefore ends with a seal commit, as the integration branch does.

No assertion was weakened or skipped. No test was gated off the hosted runner.

## Consequences

- Five test files that skipped on every CI run (nginx ×4 and the media converters) now run there.
- A developer whose `output/audits` copy makes an ignored link resolve now sees the same Gate A failure
  CI would report.
- Gate S proves the topology with every profile, as `deploy.sh` would see it, rather than the default
  profile with the host files missing.
- The cost of proving a title infeasible (decision 5) is a product-performance question for the design
  pipeline's owners; this ADR only gives the test a budget that fits the runner.
- The workflow pulls one public image (`nginx:1.27-alpine-slim`) and installs three more packages;
  both cost seconds, not minutes.
