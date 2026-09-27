# Real Canva multilingual capture — 2026-09-27

Capture source: `2d4c4de`. Requirements FR-034/035/038/041, NFR-020.
**Partial qualification; fullMultilingualAdmission=false.**

## Measured result

All 40 supplied golden strings survived the current editable-transfer encoder,
real Canva import, native content inspection and PPTX export exactly. Four
1200×2000 single-page sheets each contain ten independently addressable native
text elements. PNG, PDF and PPTX were retained. The actual Hawa typed client and
existing durable OAuth connection performed four imports and fifteen exports.
Inspection transactions were cancelled without edits.

`fixtures.json` freezes the inputs and encoder/client/checker hashes.
`live-capture.json` records operation keys, provider job/design IDs, metadata,
artifacts and failures. `offline-analysis.json` verifies these retained bytes,
native exact copy, PNG dimensions and PDF font resources. `human-review.csv`
contains 40 **not_reviewed** rows; analysis reruns never overwrite it.

| Cases | Native design | Accepted capture |
| --- | --- | --- |
| RTL-001–010 | DAHWW-oflAo | group-1-round-2 |
| RTL-011–020 | DAHWW7k0bDA | group-2 |
| RTL-021–030 | DAHWWwCxPqk | group-3 |
| RTL-031–040 | DAHWWxcep-I | group-4 |

## Findings and corrections

1. The first export set was refused because provider `updated_at` changed from
   1790478053 to 1790478055. Its files remain retained. A separate recapture of
   the same design passed the metadata check. The PNG file hashes differ, but
   decoded pixels are identical. Timestamp equality is not an atomic revision lock.
2. A local probe ordering bug dereferenced the design before polling a saved
   import job. The probe was corrected and resumed that job without another
   import. The initial transport-error interpretation was incorrect; the receipt
   preserves the correction. Two matching metadata samples now precede exports.
3. PPTX reports only `Noto Sans Arabic`, while all four PDFs also reference
   `NotoSans-Regular`; group 4 additionally contains an unnamed Type3 font.
   Family membership cannot certify rendered glyph coverage or licensing.
   This exposed a Core/Desk claim bug corrected in the accompanying source:
   explicit `fontFamilyPass`, unknown `fontCoverage`, honest UI and historical
   report projection without changing stored QC hashes.
4. The task-list SQL projection also dropped the RTL review-required flag; it
   now preserves that flag with font-family evidence.

The PNG inspection of groups 1 and 4 is an agent observation, not native-language
approval. Mixed time reading order, including the appearance of `PM 8:30`, needs
native review. PDF extracted strings are not used as a logical-text oracle.

## Limits and next admission gates

- Explicit direction is supplied from the golden oracle; auto direction is untested.
- `**NOVA**` stays literal in RTL-038/039; actual mixed style runs are untested.
- One font family and wide text boxes do not qualify multiple office fonts or narrow layouts.
- Manual typing, committed native edit/save/reopen and native-language review remain open.
- Actual font files, glyph coverage, fallback correctness and licenses remain unverified.
- Twenty real Sorani, ten Arabic and ten mixed-language office designs remain required.
- No full Hawa request, binding, human approval, delivery or deployed-image qualification occurred.

No production app restart, flag change, model call or message was performed.
The existing OAuth connection refreshed normally. The four test designs remain
in Canva; all native inspection transactions are closed.

## Reproduction and checks

Offline (requires Pillow and pypdf):

```sh
python3 output/acceptance/2026-09-27-canva-multilingual/analyze.py
```

`build_fixtures.mts` refuses to overwrite frozen inputs. `capture_live.mts`
requires the existing office connection and is **not** an offline test command:
it journals before side effects, retains known jobs, refuses uncertain submission
replay, and throttles requests. Canva documents the limits in its
[import reference](https://www.canva.dev/docs/apps/rest-apis/reference/design-imports/create-design-import-job/)
and [export reference](https://www.canva.dev/docs/apps/rest-apis/reference/exports/create-design-export-job/).

The source correction has red-before evidence (12 failures / 52 passes), then
**9 files / 122 tests passed**, covering actual exported bytes, isolated PostgreSQL
list/detail reads and unchanged QC hashes, rendered Desk states, stale policy,
manual review and approval controls. Types, lint and Desk production build pass.
The first post-fix run exposed the omitted list fields; a subsequent run started
before the DB package rebuild completed and still read its prior `dist` output.
Final verification ran after that build. Initial sandbox DB/tsx IPC errors were
environment failures; isolated DB execution and `node --import tsx` resolved them.
The historical full app suite was not rerun for this focused correction.
