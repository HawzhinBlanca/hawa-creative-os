# ADR262 — Customer current native preview

Date: 2026-10-02. Status: selected; implementation qualification pending.
Requirements: FR-029 (docs/05_CREATIVE_ENGINE.md), FR-043 (docs/11_QA_RTL_MULTILINGUAL.md), FR-069 (docs/14_SECURITY_THREAT_MODEL.md), NFR-006 (MASTER_SPEC.md). ADR256/259/260/261 and docs/30_CURRENT_STUDIO_CONTRACT.md remain authoritative.

The customer workspace displays the existing captured native Canva PNG, rather than promoting a local candidate render to final output. A narrow database routine authorizes the current workspace subject/account/client and immutable web request, follows its current task, and selects only a retrieved PNG for the bound primary native design/version. A later retrieved export observing a different native update invalidates an older PNG. Raw operational tables remain inaccessible to customer RLS context; only hawa_app receives the routine grant.

Detail returns small capture metadata. The separately authenticated binary read supplies expected request revision, capture UUID and SHA-256; changed task/binding/capture/revision is a conflict. Both reads lock and recheck live customer admission. At most two complete binary reads/validations run concurrently per Core process. Content is bounded to the existing 25 MiB native export limit, hash checked and PNG validated before HTTP delivery, with no-store/nosniff and no provider URLs, redirects, cache validators or office credentials.

The browser fetches with its current workspace identity, validates metadata and bounded PNG content/hash, and creates a transient object URL. Selection, revision/capture change, access error and unmount clear the old image and revoke that URL. Explicit refresh is available; image failures never silently preserve the previous image.

A captured preview is not human acceptance, hard-QA success, publication eligibility, or proof that no unobserved edit has occurred in Canva. Capture time is displayed; final acceptance/download gates must independently bind current QA and observed native version. No paid provider call is made by preview polling.

Acceptance: isolated real PostgreSQL customer/current-task/binding/capture/revocation/privilege controls; mounted authenticated HTTP binary/hash/no-cache refusals; website bounded transport and object URL disposal; actual browser display/change/revocation. Synthetic browser/provider fixtures establish UI behavior only, not native visual quality or public customer readiness.
