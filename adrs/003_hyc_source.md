# ADR-003: Use `.hyc` plus a neutral manifest as the creative source

**Status:** Accepted  
**Date:** 2026-09-03

## Context

A flattened image is not acceptable, and storing only a studio document ID creates lock-in. A universal fully lossless design format does not exist for all editor features.

## Decision

Store exact `.hyc` source bytes, schema/studio version, hash, assets/fonts, and a neutral semantic sidecar manifest. Generate standard PNG/SVG/PDF and optional conversion exports. Approval binds the immutable source revision.

## Consequences

Full local editability and recovery are preserved. Migration remains possible but may not be feature-lossless. The neutral manifest must be maintained and validated.

## Alternatives considered

HTML as only source: excellent RTL but weaker direct editing for designers. PSD as canonical: proprietary/complex and hard to automate. Vendor document ID only: rejected.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
