# ADR-116 — Retain and verify the actual font basis

Date: 2026-09-28. Status: accepted; font-basis recovery locally qualified, full renderer/native qualification pending.
Requirements: FR-015/036/060, NFR-009/024; MASTER_SPEC.md, docs/05, docs/08,
docs/10, docs/11 and docs/30 via plans/traceability.csv.

## Decision

Retain the font registry content hash and the hashes of the actual packaged and
allowlisted system font files with each new visual-input bundle. Verify the current
font basis before restoring retained inputs. Changed/missing font files or a changed
registry hold the existing run before another model/render stage; they cannot be
silently adopted by resuming it. Historical bundles without font evidence require
review rather than fabricated retroactive attestation. No migration or new service.

Fontkit objects must not survive file replacement under the same pathname. Cache
by observed file identity (inode/size/nanosecond modification/change times), loading
and hashing bytes after a change and refusing a changing read. File deletion is an
error, not a cache hit. The inventory hashes actual bytes without a metadata-only
shortcut at the recovery boundary. Fontconfig generation and family-discovery caches
also incorporate actual font inventory identity. Clear renderer admission/ink caches
when the admitted registry/font basis changes.

This closes font-input drift, not full renderer hermeticity. Native rasterizer,
shaping dependency and OS/shared-library identities, binary retention/licensing,
concurrent modification during a running stage, actual Canva fonts and native human
review remain separate qualification. Deployment should replace immutable artifacts,
not modify font files while a stage runs. Source-copy order remains protected;
a model readingOrder still does not authorize changing it.

## Acceptance

Reproduce same-path stale font measurements. Prove that changed, deleted and restored
fonts change measurements/identity correctly, registry changes invalidate admission,
and content-equivalent copies are stable. Test real isolated-DB retained recovery,
changed/absent font evidence refusal before a provider/stage call, and restoration
of the original environment. Retain affected typography and render regressions,
source/test types, security and measured local inventory overhead.

## Local evidence and rollout

The previous same-path loader reproduces stale measurements (472px before and after
replacing Noto with Amiri); the corrected loader observes replacement, deletion and
restoration. The connected suite passes 147 tests across 11 files. Source/scripts
and 527 strict test roots pass after fixing two test-only unknown-object spreads.
Local 30-sample inventory measurement covers 27 fonts at approximately 4ms p95.

New visual bundles use version 2. Version 1 bundles have no font attestation and
are held; retain their original results for operator review before rollout. Do not
backfill current hashes as if they proved the historical rendering environment.
See `plans/lean-design-implementation-2026-09-28/FONT_BASIS_PROOF.json`.
