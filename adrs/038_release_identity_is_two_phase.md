# ADR-038: Separate Source Candidate Evidence from Deployed Image Evidence

**Date:** 2026-09-25  
**Status:** Accepted for the research-grade branch; implementation and live admission remain open.  
**Requirements:** FR-065, FR-069, NFR-011, NFR-013, NFR-025; R03 in `plans/research-grade-upgrade-2026-09-25/PLAN.md`.

## Context

`RELEASE_MANIFEST.json` currently says `environment: production`, lists `hawa-core:latest` / `hawa-desk:latest` / `hawa-worker:latest`, and calls a fixed set of model names “pinned.” The canonical Compose file actually builds images locally and its release override uses different mutable tags. The active Canva design path resolves models from `packages/domain/src/provider-policy.ts` and deployment environment overrides, while the manifest's fixed model list describes another gateway. A passing manifest checksum proves consistency of that JSON and a few source hashes. It cannot prove which image, model override, prompt, or migration ran in production.

## Decision

1. A checked-in v2 release manifest describes a **source candidate**: commit, source hashes, intended topology, schema files, and declared default policy. It marks images `unbuilt` and runtime model overrides/QA version `unobserved`; it never claims a built or deployed image digest. Mutable tags are references, not identities.
2. `deploy.sh` must reject an explicit `HAWA_BUILD_COMMIT` that differs from the clean checkout's HEAD before it contacts Docker or PostgreSQL. Built Core, Desk and Worker images carry that commit as an OCI revision label. The deploy verifies each built image's label before switching traffic.
3. A separate deployment receipt is written only after inspecting the actual containers and images. It records immutable image IDs, their revision labels, the database's applied migration name and checksum, effective non-secret flags/model choices, release manifest hash, deployment time, and the live worker colour. If any required observation is missing or mismatched, admission remains unknown/failed. The receipt is not synthesized from the source manifest.
4. Evaluation and task/export evidence refer to this deployment receipt and their own input/final artifact hashes. The source candidate alone cannot qualify a shipped system.

## Rollout

First land the checkout-stamp refusal, image labels and inspected deployment receipt with offline negative controls. Then bind release/evaluation records to it. No production deployment or global flag switch is implied by this ADR. R03 remains in progress until the exact built candidate is inspected, task/export provenance is joined and a rollback path is proven.
