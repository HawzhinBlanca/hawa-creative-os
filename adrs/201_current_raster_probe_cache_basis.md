# ADR201 — Current raster inputs before ink and sentinel cache reuse

Date: 2026-10-01. Status: source engineering qualified; product admission open.
Requirements: FR-038, FR-041, NFR-012, NFR-024.
Sources: docs/05_CREATIVE_ENGINE.md, docs/11_QA_RTL_MULTILINGUAL.md;
ADR116/118/123/200; W5_RASTER_PROBE_CACHE_FINDING.json.

## Evidence

After a temporary same-path renderer starts failing, a warmed ink probe still
returns its old measured object while a fresh query is unmeasured. Path-only ink
and sentinel keys bypass current input identity. This is an exported-function
reproduction, not an established live outage; Core also captures input identity.

## Decision

Before cache reuse, verify current renderer executable/OS identity, measured
font bytes and font configuration. Reuse the existing stable font loader and
renderer identity implementation. Normal generated font configurations already
bind the current allowed font inventory; combine that identity with current
configuration bytes. Preserve unchanged-input ink hits and one shared sentinel
per current raster basis/sample/size.

Custom configurations may include settings and font directories outside the
generated inventory. Without a complete dependency attestation, run both custom
ink and sentinel probes fresh, including when their top-level file is unchanged.
A caller explicitly passing the current generated configuration can retain reuse.
Do not guess include dependencies or add a configuration parser/framework.

Never retain a failed sentinel as a valid comparison or cache an incomplete
probe. An unavailable sentinel is explicitly unmeasured and can recover on the
next call. Existing contrast, glyph and ink tolerances, exact copy, font choice,
editable output and provider/repair budgets remain unchanged. No production
font, configuration or executable is modified during qualification.

## Qualification

Retain original red regressions. Exercise renderer failure/replacement/recovery,
measured font corruption/removal/replacement with restored mtime, custom include
mutation, sentinel invalidation and transient recovery, unchanged-input cache
reuse and shared sentinel raster count. Include actual local rendering, Core
visual-input recovery, transfer and hard QA. Exact engineering qualification is
separate from native Canva, human typography/design quality and product admission.

Renderer identity still does not attest every shared-library byte or arbitrary
wrapper dependency (ADR123). Deployment uses immutable artifacts; concurrent
external mutation during a render remains outside this cache repair's guarantee.


Six original regressions fail/one unchanged-input control passes. Initial connected21pass/2 historical fake-contract failures retained; corrected fakes answer --version independently of raster logging without weakening count/environment assertions. Final connected12files93pass/0fail/0skip,673 strict test roots/lint pass. W5_RASTER_PROBE_CACHE_PROOF.json; exact seal and product admission pending.


Exact sealedf767ddfae2ecd3bcd024d659d8c2d6a9ed4c63a1: all8,6580pass/0fail/67skip across666 passed files/6 skipped;673 strict roots,1686 blueprint checks,newest production dump restored in isolation and mandatory negative-flag refusal pass. Raster/font/config cache and transient sentinel recovery qualified in source; no deploy or native Canva/human/product admission. W5_RASTER_PROBE_CACHE_GATE_EVIDENCE.json retains exact gate. Next actual temporary-renderer diagnostic: probeFontScripts Amiri Arabic is unmeasured, getFontFidelityManifest reports exact and reviewFindings emits no font warning. W5_FONT_FIDELITY_REPORT_FINDING.json is an exported probe/manifest/review-chain diagnostic, not whole shipping admission or a live outage; acceptance regression NOT_RUN/repair pending.
