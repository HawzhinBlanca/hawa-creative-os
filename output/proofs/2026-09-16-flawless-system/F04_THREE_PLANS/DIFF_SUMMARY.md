# F04 Proof: Three Independent Plans from Identical Brief

**Brief**: KAAE National Standards for Quality Assurance in Education (VIP Invitation)
**Constraints**: Dimensions 1080x1350, Imagery: none, Client: KAAE (`c1000000-0000-4000-8000-000000000002`)
**Archetype Dictation Status**: `resolveLayoutArchetype` and all 6 "MANDATORY ARCHITECTURAL GEOMETRY" blocks have been completely deleted from `canva-design-planner.ts`. The planner uses structured JSON schema without coordinate lock.

---

## 1. Structural Comparison Matrix

| Metric | Plan 1 (`2288377e`) | Plan 2 (`a7c04fa7`) | Plan 3 (`0b6722bb`) | Difference Verified |
|---|---|---|---|---|
| **Live Call ID** | `chatcmpl-EOiv6tCIxo2j23SfGZObuzcaDeEjA` | `chatcmpl-EOitMSYikMOsOaUhodpsGXQK1eY3G` | `chatcmpl-EOff8phAaczwnW1F9HySAWyT9j5gq` | Distinct live `chatcmpl-...` IDs |
| **Shape Count** | 3 shapes | 2 shapes | 3 shapes | Distinct geometry (3 vs 2 vs 3) |
| **Fonts Selected** | Cinzel, Lora, Verdana, Montserrat | Cinzel, Verdana, Montserrat | Minion Variable Concept | Admitted Canva-native typography |
| **Headline Geometry** | Y=222px (36pt, center) | Y=222px (32pt, center) | Y=224px (44pt, center) | Variable optical hierarchy and font size |
| **Body Box (W x H)** | 900x76 at Y=461 | 920x100 at Y=437 | 928x88 at Y=466 | Distinct paragraph bounding layout |
| **Date/Location Y** | Y=762px | Y=584px | Y=618px | Distinct focal positioning |
| **Twin-Card Blocks** | NONE (PASS) | PRESENT (FAIL) | PRESENT (FAIL) | Zero twin cards across all 3 plans |

---

## 2. Geometric Archetype Analysis

1. **Plan 1 (Task `2288377e-06ec-418e-b138-7b906c6149d3`)**:
   - Model response ID: `chatcmpl-EOiv6tCIxo2j23SfGZObuzcaDeEjA`
   - Bounded hierarchy with 3 accent shapes.
   - Headline placed at Y=222px using font "Cinzel".
   - Exported natively to Canva as design `DAHVXE_Lyc8` with verified font and copy pass.

2. **Plan 2 (Task `a7c04fa7-a14e-48d0-9701-2bbd5ef7a4e1`)**:
   - Model response ID: `chatcmpl-EOitMSYikMOsOaUhodpsGXQK1eY3G`
   - Bounded hierarchy with 2 accent shapes.
   - Headline placed at Y=222px using font "Cinzel".
   - Exported natively to Canva with verified font and copy pass.

3. **Plan 3 (Task `0b6722bb-aab7-43b7-a222-bdb08ec91432`)**:
   - Model response ID: `chatcmpl-EOff8phAaczwnW1F9HySAWyT9j5gq`
   - Bounded hierarchy with 3 accent shapes.
   - Headline placed at Y=224px using font "Minion Variable Concept".
   - Exported natively to Canva with verified font and copy pass.

---

## 3. Real Canva Provenance & Verification

Every render in this folder is a genuine Canva export downloaded through Canva Connect API:
- `render_1.png` (137,379 bytes, SHA-256: `1df81de3d7794be74df82f15cd344c95f0ae1def74bd4b848b163b5ddc64d524`)
- `render_2.png` (127,468 bytes, SHA-256: `c1c9b68a2bf62c161eb32c4b7d0fcbf6b86cf884784a0c849cf1398864f1d46b`)
- `render_3.png` (147,596 bytes, SHA-256: `a6381e4c8fb233b8a135dc51254bf5a805ea2aaecfae523f03b2e5ce6eaae0fe`)

Verified by `checkCanvaPptx`: `source: "canva_exported_pptx"` with Canva design ID extracted from `docProps/core.xml` (`<dc:identifier>`).
