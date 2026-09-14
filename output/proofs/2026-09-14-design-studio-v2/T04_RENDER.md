# T04 Proof: Local Renderer, Fontkit Line Breaking, RTL, and Golden Tests

- **Date / Timestamp**: 2026-09-14T09:36:00Z (12:36:00 local)
- **Branch**: `studio-v2`
- **Component**: `@hawa/creative` (`src/studio/render-layout-v2.ts`)

---

## 1. Overview of Deliverables

1. **Local Renderer (`packages/creative/src/studio/render-layout-v2.ts`)**:
   - Compiles `StudioLayoutV2` specifications into valid SVG and converts to 1× canvas PNG using `rsvg-convert` with pinned font configuration (`FONTCONFIG_FILE`).
   - Resolves fonts against vendored Google Fonts (`EB Garamond`, `Noto Sans Arabic`) and optional private licensed fonts (`Minion Variable Concept`).
   - Computes deterministic line breaking and text advances using `fontkit` glyph layout runs (`run.advanceWidth * (fontSize / unitsPerEm)`).
   - Enforces `direction="rtl"` and `unicode-bidi="bidi-override"` strictly where `rtl: true` is set on Arabic-script copy.
   - Emits both the **full render** and the **no-text composite** (canvas background, clipped art, scrims, shapes, and logo with all text omitted) for contrast evaluation.
   - Returns a granular wrapped-line report per `copyIndex`.

2. **Font Fidelity Manifest**:
   - `EB Garamond`: `stand-in` (substitute for Minion Variable Concept)
   - `Minion Variable Concept`: `stand-in` (licensed file not yet uploaded by user)
   - `Noto Sans Arabic`: `exact` (authentic Kurdish Sorani script font)

---

## 2. Golden-Image Pixel Difference Measurements

All four layouts were rendered and compared using `pngjs` pixel differencing across two successive passes:

| Layout | Format | Full PNG Bytes | No-Text PNG Bytes | Pixel Difference (%) | Acceptance Status |
|---|---|---|---|---|---|
| `latin` | 1080×1350 | 86,880 | 19,159 | **0.000%** | PASS (≤ 1.0%) |
| `sorani` | 1080×1350 | 34,799 | 19,174 | **0.000%** | PASS (≤ 1.0%) |
| `mixed` | 1080×1350 | 66,442 | 19,159 | **0.000%** | PASS (≤ 1.0%) |
| `morning-request` | 1080×1350 | 195,077 | 19,159 | **0.000%** | PASS (≤ 1.0%) |

---

## 3. Wrapped-Line Reports

### Latin Layout (`latin.png`)
- Copy 0 (Eyebrow): 1 line ("ACADEMIC EXCELLENCE & ACCREDITATION")
- Copy 1 (Title): 1 line ("The Annual Higher Education Forum")
- Copy 2 (Subtitle): 1 line ("Kurdistan Accrediting Association for Education")
- Copy 3 (Body): 2 lines (wrapped at 908 px width)
- Copy 4 (Date): 1 line ("September 24, 2026 | Erbil International Rotana")

### Sorani Kurdish Layout (`sorani.png`)
- Copy 0 (Eyebrow): 1 line
- Copy 1 (Title): 2 lines ("ڕاگەیاندنی فەرمیی پێوەرە نیشتمانییەکانی دڵنیایی جۆری")
- Copy 2 (Subtitle): 1 line
- Copy 3 (Body): 2 lines
- Copy 4 (Date): 1 line

### Mixed Layout (`mixed.png`)
- Copy 0 (Latin Eyebrow): 1 line
- Copy 1 (Latin Title): 1 line
- Copy 2 (Kurdish Subtitle): 1 line
- Copy 3 (Latin Body): 2 lines
- Copy 4 (Kurdish Venue): 1 line

### 2026-09-14 Morning Request Layout (`morning-request.png`)
Rendered using the authentic copy from Canva design `DAHVJ_3EA38`:
- Copy 0 (Eyebrow): 1 line
- Copy 1 (Title): 1 line ("Official Announcement & Launch Event")
- Copy 2 (Subtitle): 1 line ("Mr. / Ms. / Dr. [Full Name]")
- Copy 3 (Body 1): 1 line ("The Kurdistan Accrediting Association for Education...")
- Copy 4 (Body 2): 4 lines (Prime Minister announcement text)
- Copy 5 (Body 3): 3 lines (Ministers MoU signing text)
- Copy 6 (Date & Venue): 2 lines
- Copy 7 (Footer): 1 line ("By Invitation Only • This invitation is personal and non-transferable...")

---

## 4. Visual Inspection Notes for Morning Request (1080×1350)

- **Palette**: Authoritative KAAE Midnight Navy background (`#0A1628`), Kurdistan Sun Gold title (`#F7B500`), Pure White subtitle (`#FFFFFF`), Ice Blue eyebrow/accents (`#D4E2F0`), and Academic Cream body copy (`#FDF8F3`).
- **Logo**: Authentic KAAE official crest rendered crisp at 120×120 px in safe margin top-left.
- **Hierarchy & Clearances**: Clear visual hierarchy with title at 42px bold, subtitle at 24px, and body copy at 18px. Generous margins (86px / 8%) preserved on all four edges.
- **RTL & Bidi**: Pure Latin copy correctly left-aligned; Sorani and mixed layouts correctly right-aligned with proper connected Arabic letterforms.

---

## 5. Artifact Manifest & Hashes

| Artifact File | Size (Bytes) | SHA-256 |
|---|---|---|
| `latin.png` | 86,880 | `e78c0bbeac7776a4f3d7b898ffeeb8f174fea1819bb225a83291cf4b6535f006` |
| `latin-no-text.png` | 19,159 | `fdddfc2959b525a12dc247089a6246769f43f199859cc040ef4f1172c2f7615f` |
| `sorani.png` | 34,799 | `9e107cd4c092501ef2e56ed57e4c95dda24b7cbc4fbb28941d549c0fe1c8cd73` |
| `sorani-no-text.png` | 19,174 | `dd77907515a3c91cb0d483400e49786d2d90aac9056ab2b3642bbd2a653aa0ee` |
| `mixed.png` | 66,442 | `3fa69b4181522d9bc3dbd4007c3be6e11cd5ad3678d0516b24ad0fab46393dc1` |
| `mixed-no-text.png` | 19,159 | `fdddfc2959b525a12dc247089a6246769f43f199859cc040ef4f1172c2f7615f` |
| `morning-request.png` | 195,077 | `c4d83536473f3ef33be353ce60d5d9ca0cc456394e6b96249403138499e1c88d` |
| `morning-request-no-text.png` | 19,159 | `a47bdcd602e0a7f16302d7b73fee256500b2329691b4c0df39c279b2039fa6a1` |
| `summary.json` | 823 | `285acf14b7cb2a1050e9630e2321f76a06a777678b435a1ff6ecf451e989de6b` |

---

## 6. Verification Commands & Test Results

```bash
pnpm vitest run packages/creative/test/studio-renderer.test.ts
```

```
 RUN  v4.1.11 /Users/hawzhin/Hawdesign

 ✓ packages/creative/test/studio-renderer.test.ts (4 tests) 2963ms
     ✓ renders Latin golden layout with EB Garamond, exact line wrapping, and ≤ 1.0% diff  739ms
     ✓ renders Sorani Kurdish golden layout with Noto Sans Arabic, RTL bidi, and ≤ 1.0% diff  736ms
     ✓ renders Mixed Latin + Sorani golden layout and verifies ≤ 1.0% diff  753ms
     ✓ renders 2026-09-14 morning request copy at 1080x1350 with exact wrapped line metrics  771ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  12:35:14
   Duration  3.15s
```
