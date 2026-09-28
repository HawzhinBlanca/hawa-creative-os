# Native Canva reconstruction probe — 27 September 2026

Source: `751556fb1feebe221a89129ed3ddabde44fe4d16`. Requirements: FR-028,
FR-031, NFR-010. R19 remains **in progress**.

## Measured result

The prior real Hawa import test `DAHVE6fjdhk` was copied to `DAHWWmZ3P3g`.
Canva's connector exposed three independently addressable native text elements.
A draft changed one marker, preserving the other text and all three element
geometries. Save approval required by the Canva commit tool did not arrive;
the draft was cancelled. **Committed edit/save/reopen is not qualified.**

The current Hawa `CanvaConnectService` refreshed the existing expired OAuth
connection and the current `CanvaConnectClient` read the copy and produced actual
PNG, PDF and PPTX exports. These calls used the existing durable credential owner,
not a copied refresh token. No credentials or signed artifact URLs are retained.
No running app service was restarted; the normal OAuth rotation was persisted.

The PNG decodes to 1024×768. The PDF and PPTX retain all three exact English text
blocks. The current PPTX checker passes the fixture's exact copy and explicit Arial
family; it refuses both the uncommitted replacement and a wrong Verdana policy.
Its `fullReleasePass` remains false. This fixture policy changes no client DNA.

The retained PPTX was imported as `DAHWWrLK0so`, then inspected in a fresh native
Canva transaction and exported to PNG. All three exact text blocks remain native,
independently addressable text; their native IDs are regenerated. Text boxes move
up by 3/2/2 px and grow by 3/2/2 px. 17,657 of 786,432 decoded pixels differ
(2.2452%). This is **partial layout reconstruction**, not a lossless round-trip.
The inspection-only transaction was cancelled; no native transaction remains open.

## Recheck retained artifacts without live calls

Run from the repository root:

```sh
node --import tsx output/acceptance/2026-09-27-native-canva/check_captured_pptx.mts
python3 output/acceptance/2026-09-27-native-canva/inspect_artifacts.py
```

The Python check needs `pypdf`; this run used the bundled Codex Python runtime.
PyMuPDF was unavailable. The first QA harness had a relative-import typo and the
tsx CLI encountered a sandbox IPC refusal; the corrected `node --import tsx`
command passes. Those setup failures are not counted as application checks.

`capture_exports.mts` and `reimport_capture.mts` retain the exact bounded live
capture recipes. They read this host's configured Hawa connection and may rotate
its token. Their journals claim each operation before submission and refuse to
repeat an uncertain attempt. They are evidence recipes for these fixed test
designs, not production task workflow entry points. Do not invoke them merely to
recheck the retained files.

## Boundaries

- No current Hawa task, binding, review, approval, publication or delivery was
  created. The connector and typed Connect client were exercised directly.
- No human design-quality or native-language acceptance was recorded.
- No logo, photo, vector/group, Sorani/Arabic or account-loss recovery was tested.
- An online reimport into the same account does not qualify offline or
  vendor-independent recovery.
- Equal Canva metadata timestamps across capture do not create an atomic native
  revision lock.
- Two disposable designs, four export jobs and one import job were created;
  no model calls or messages were sent. The original text remains unchanged.

Authoritative receipt: `plans/research-grade-upgrade-2026-09-25/R19_NATIVE_CANVA_PROOF.json`.
