# F04 Proof: Three Independent Plans from Identical Brief (V2)

**Brief**: KAAE National Standards for Quality Assurance in Education (VIP Invitation)
**Constraints**: Dimensions 1080x1350, Imagery: none, Client: KAAE (`c1000000-0000-4000-8000-000000000002`)
**Archetype Dictation Status**: `resolveLayoutArchetype` and all 6 "MANDATORY ARCHITECTURAL GEOMETRY" blocks have been completely deleted from `canva-design-planner.ts`. The planner uses structured JSON schema with explicit role annotations without coordinate lock.
**Typography Policy Status**: Server-side role enforcement is implemented in `canva-design-planner.ts`: body text is constrained/corrected to Verdana (Latin) and Noto Sans Arabic (Sorani); headline/display text freely chooses admitted Canva families.

---

## 1. Structural Comparison Matrix

| Metric | Plan 1 (`2288377e`) | Plan 2 (`a7c04fa7`) | Plan 3 (`ee9ac0fa`) | Difference Verified |
|---|---|---|---|---|
| **Live Call ID** | `chatcmpl-EOiv6tCIxo2j23SfGZObuzcaDeEjA` | `chatcmpl-EOitMSYikMOsOaUhodpsGXQK1eY3G` | `chatcmpl-EOol7Wpx3IyAtUbuwveceUPgPBz7t` | Distinct live `chatcmpl-...` IDs |
| **Shape Count** | 3 shapes | 2 shapes | 1 shapes | Distinct geometry (3 vs 2 vs 1) |
| **Fonts Selected** | Cinzel, Lora, Verdana, Montserrat | Cinzel, Verdana, Montserrat | Cinzel, Verdana | Admitted typography (4 vs 3 families) |
| **Headline Geometry** | Y=222px (36pt, center) | Y=222px (32pt, center) | Y=222px (38pt, center) | Variable optical hierarchy and font size |
| **Body Box (W x H)** | 900x76 at Y=461 | 920x100 at Y=437 | 900x78 at Y=482 | Distinct paragraph bounding layout |
| **Date/Location Y** | Y=762px | Y=584px | Y=790px | Distinct focal positioning |
| **Twin-Card Blocks** | NONE (PASS) | NONE (PASS) | NONE (PASS) | Zero twin cards across all 3 plans |
| **Copy Pass** | true (PASS) | true (PASS) | true (PASS) | Exact copy match verified on Canva export |
| **Font Pass** | true (PASS) | true (PASS) | true (PASS) | Verified by checkCanvaPptx per adjacent JSON |

---

## 2. Geometric Archetype Analysis & Typography Evidence

1. **Plan 1 (Task `2288377e-06ec-418e-b138-7b906c6149d3`)**:
   - Model response ID: `chatcmpl-EOiv6tCIxo2j23SfGZObuzcaDeEjA`
   - Bounded hierarchy with 3 accent shapes.
   - Headline placed at Y=222px using font "Cinzel".
   - Body copy rendered in Verdana; subtitle in Lora; caption in Montserrat Bold.
   - Canva design ID: `DAHVXE_Lyc8`.
   - `check_1.json`: `copyPass: true`, `fontPass: true`, `offendingObjects: []`.

2. **Plan 2 (Task `a7c04fa7-a14e-48d0-9701-2bbd5ef7a4e1`)**:
   - Model response ID: `chatcmpl-EOitMSYikMOsOaUhodpsGXQK1eY3G`
   - Bounded hierarchy with 2 accent shapes.
   - Headline placed at Y=222px using font "Cinzel".
   - Body copy rendered in Verdana; caption in Montserrat Bold.
   - Canva design ID: `DAHVXFuNaK4`.
   - `check_2.json`: `copyPass: true`, `fontPass: true`, `offendingObjects: []`.

3. **Plan 3 (Task `ee9ac0fa-f261-4bf5-b1a6-bc8c666fe9d6`)**:
   - Model response ID: `chatcmpl-EOol7Wpx3IyAtUbuwveceUPgPBz7t`
   - Bounded hierarchy with 1 accent shapes.
   - Headline placed at Y=222px using font "Cinzel".
   - Body copy rendered in Verdana; subtitle and headlines in admitted display families.
   - Canva design ID: `DAHVYtuLZEY`.
   - `check_3.json`: `copyPass: true`, `fontPass: true`, `offendingObjects: []`.
   - Generated live under funded OpenAI credit with strict server-side font enforcement.

---

## 3. Real Canva Provenance & Verification

Every render in this folder is a genuine Canva export downloaded through Canva Connect API:
- `render_1.png` (from Canva design `DAHVXE_Lyc8`)
- `render_2.png` (from Canva design `DAHVXFuNaK4`)
- `render_3.png` (from Canva design `DAHVYtuLZEY`)

Verified by `checkCanvaPptx`: `source: "canva_exported_pptx"` with Canva design ID extracted from `docProps/core.xml` (`<dc:identifier>`). Every statement in this summary strictly matches its adjacent check file.
