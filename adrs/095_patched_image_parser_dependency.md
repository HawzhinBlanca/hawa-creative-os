# ADR-095 — Remove the patched image-size audit exceptions

Date: 2026-09-27
Status: Accepted; source compatibility qualification only, runtime rollout pending
Requirements: NFR-013

The production dependency audit still counts two high-severity parser denial-of-
service advisories, suppressed by dated exceptions in pnpm-workspace.yaml.
Registry inspection now returns image-size 2.0.4; both advisories identify 2.0.3
as patched. The exception's statement that no patch exists is obsolete.

Pin the pptxgenjs 4.0.1 transitive image-size dependency to 2.0.4 via the workspace
override, remove both ignores and regenerate the lockfile. Keep pptxgenjs itself
pinned. This crosses the image-size major-version boundary and therefore requires
actual editable transfer tests, including image-bearing output, before acceptance.
The existing pptxgenjs CJS bundle does not import image-size at module load; do not
infer whole-document compatibility from that inspection alone.

Verify registry audit with no ignored advisories, regenerate CycloneDX evidence,
and run transfer/Canva QA plus the full sealed release regression. No live Canva
admission is implied by generated PPTX tests.

Sources checked 2026-09-27:
- https://github.com/advisories/GHSA-w3rx-r6r6-pgpr
- https://github.com/advisories/GHSA-5p2g-fcmc-qvqq
- Registry: `pnpm view image-size version` -> 2.0.4.
