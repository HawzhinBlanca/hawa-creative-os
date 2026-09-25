# ADR-047: Explicit Client Logo at the Studio Renderer Boundary

**Date:** 2026-09-25  
**Status:** Accepted for the local R11 implementation. Client-general product admission remains open.  
**Requirements:** FR-017, FR-027.  
**Amends:** The implicit KAAE logo behavior in the Studio renderer; it does not change ADR-036's rasterizer selection.

## Context

`renderLayoutV2ToSvg` previously chose the packaged KAAE logo whenever a logo-bearing layout had no `logoDataUri` or available `logoPath`. A second client's missing asset could therefore become a plausible but wrong branded preview. The same render function feeds critique, pairwise judging, degraded canaries, revision previews, and delivery preparation. A missing logo here is an identity failure, not a rendering preference.

## Decision

For a layout with a logo node, the renderer requires explicitly supplied, decodable image bytes through `logoDataUri` or `logoPath`. Missing or invalid input throws before a PNG or SVG can be accepted. A layout without a logo node needs no logo input. The renderer does not select any packaged client logo.

The Core Studio stages pass the task's resolved logo bytes into the judge, refinement, and final render paths. Historical KAAE tests explicitly supply the packaged KAAE image as their fixture. Art composition and fallback/canary renders use the same caller-supplied options. The artifact's approval, ownership, and hash binding remain the responsibility of client-reference resolution and transfer validation; this renderer boundary does not establish them.

## Consequences

- Missing client assets fail closed and cannot silently contaminate another client's visual evidence.
- Direct render callers must supply logo bytes when their layout contains a logo. Existing data with a missing logo will surface as an explicit error until its scoped asset is recovered.
- A test with another client's pixels checks that the output differs from the packaged KAAE logo. This is a local isolation control, not a three-client design or Canva export qualification.

## Alternative rejected

Keeping the KAAE fallback while hiding it behind a flag would leave a path where absent client identity produces valid-looking but wrong output. An unbranded placeholder would also allow a preview to pass through judgment without the required official mark. Both mask an invalid input instead of repairing it.
