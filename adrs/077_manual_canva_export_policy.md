# ADR-077 — Checked exports without an imported source

Date: 2026-09-27. Status: accepted for implementation; live admission remains open.

## Evidence and requirements

FR-015/017/041/043/054/064/069, NFR-017/020; docs/08, docs/10,
docs/11, docs/14 and docs/30. A manual Desk request can create a blank Canva
design, but checked PPTX export requires an imported Hawa source. Consequently
the native manual workflow cannot reach source-backed review.

## Decision

Use the existing durable export operation to pin a checking policy before its
external submission. Imported designs pin the matching imported source's copy
and font expectations. Without that source, only a manual Desk task with exact
saved copy and active, hash-verified, human-authored Client DNA is admitted.
Pin the task's creation event, exact copy, client, DNA version/hash and explicitly
listed font families by supported script. No packaged reference, default font,
inferred import, generated text, or arbitrary other design's source qualifies.
This is family-membership checking; font files, glyph coverage, role-specific
layout, native editability and visual quality retain their separate gates.

Lock task, binding and active DNA at admission. Persist the policy with the
operation and prevent subsequent mutation. Exact-key replay reads the original
policy even if DNA changes; the retained export remains historical evidence.
New review, approval and publication refuse a superseded policy. A new capture
uses a new key and the currently active DNA. Old operations retain their legacy
source-based recovery path; they do not acquire invented historical policies.

Manual checks inspect explicit font declarations for the scripts actually in
each run; mixed text requires each relevant script's approved family. Missing
declarations and unsupported scripts remain failures. User text stays unchanged.
Capture never grants approval or proves native Canva reopening.

## Acceptance

Exercise actual export transport and retained PPTX bytes with no imported-source
row, then capture → review → authorized approval. Cover exact-copy/font failures,
missing/draft/cross-client/corrupt DNA, policy immutability, concurrent replay,
restart/resume, policy supersession before review/approval/publication, stale
binding and tenant/actor scope. Retain failures and unexecuted live gates.
