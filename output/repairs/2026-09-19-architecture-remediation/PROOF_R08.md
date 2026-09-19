# Proof Dossier: Task R08 — Prove Editable Transfer and Final Output Fidelity

**Date:** 2026-09-19  
**Status:** QUALIFIED / PROVED  
**Normative Standards:** ADR-025, FR-015, FR-034–039, FR-045, FR-075, NFR-008, NFR-009  
**Audit Finding Addressed:** Defect F06 (Silent visual property degradation in editable transfer)  
**Test Evidence:**  
- `packages/creative/test/r08-transfer-fidelity.test.ts` (5/5 passed)  
- `packages/creative/test/transfer-v2.test.ts` (5/5 passed)  
- `packages/creative/test/editable-transfer-rtl.test.ts` (2/2 passed)  
- Direct DrawingML XML Inspection Probe: All 6 fidelity indicators verified `true`  

---

## 1. Defect Analysis & Counterexample (F06)

### 1.1 Baseline Defect
In the baseline audit (`output/audits/2026-09-19-architecture-reliability/SECURITY_ARCHITECTURE_FINDINGS.md`):
> "The real encoder was given a 20%-opaque ellipse, 45-degree rotation and blue stroke. PPTX XML contained rectangles, no ellipse, no requested alpha, no rotation and no blue stroke. The manifest still described the shape as an ellipse with opacity and blue stroke. Text opacity and spacing also disappeared."

The audit recorded:
```json
{
  "actualShapeTypes": ["rect", "rect"],
  "ellipsePreserved": false,
  "rotationPreserved": false,
  "shapeOpacityPreserved": false,
  "blueStrokePreserved": false,
  "textOpacityPreserved": false,
  "textSpacingPreserved": false
}
```

### 1.2 Root Cause in Code
1. **Hardcoded Rectangle Shape Type:** In `packages/creative/src/studio/transfer-v2.ts`, shape rendering unconditionally called `slide.addShape(pptx.ShapeType.rect, ...)` regardless of `shape.kind`. Any ellipse, rounded rectangle, or line was serialized as a standard rectangle.
2. **Dropped Shape Transformations:** Shape `rotation` was entirely omitted from `studioLayoutV2ToTransferPlan` and `addShape` options.
3. **Dropped Shape Stroke & Fill Alpha:** Shape fill was passed as solid hex with zero alpha (`transparency: 0`), and shape stroke properties (`strokeWidth`, `strokeColor`) were ignored.
4. **Dropped Text Alpha & Character Spacing:** Text run formatting ignored `opacity` and `letterSpacing`, dropping text transparency and character spacing.
5. **Manifest vs Reality Divergence:** The generated manifest JSON claimed the plan had ellipses, rotation, strokes, and opacity, while the delivered PPTX binary contained only flat, opaque, unrotated rectangles.

---

## 2. Architecture & Implementation Remediation

### 2.1 Extended Transfer Plan Schema (`packages/creative/src/editable-transfer.ts`)
Extended `EditableTransferPlan`:
```typescript
export interface EditableTransferPlan {
  // ...
  text: Array<{
    // ...
    italic?: boolean;
    opacity?: number;
    letterSpacing?: number;
  }>;
  shapes: Array<{
    // ...
    rotation?: number;
    strokeWidth?: number;
    strokeColor?: string;
  }>;
}
```

### 2.2 Fidelity Serialization in PPTX DrawingML (`packages/creative/src/studio/transfer-v2.ts` & `editable-transfer.ts`)
1. **Dynamic Shape Geometry:**
   - Ellipses map to `pptx.ShapeType.ellipse` (`<a:prstGeom prst="ellipse">`).
   - Rounded rectangles map to `pptx.ShapeType.roundRect` (`<a:prstGeom prst="roundRect">`).
   - Lines map to `pptx.ShapeType.line` (`<a:prstGeom prst="line">`).
2. **Rotation (DrawingML `rot` attribute):**
   - Serialized via `rotate: shape.rotation`.
   - DrawingML represents rotation in 60,000ths of a degree (e.g., 45° = 2,700,000, verified in slide XML).
3. **Alpha / Transparency (DrawingML `<a:alpha val="...">`):**
   - Transformed via `transparency = Math.round((1 - opacity) * 100)`.
   - Shape fill alpha: 20% opacity = 80% transparency, yielding `<a:alpha val="20000">`.
   - Text alpha: 30% opacity = 70% transparency, yielding `<a:alpha val="30000">`.
4. **Stroke Formatting:**
   - Passed with stroke color, width scaled to points, and solid opacity (`transparency: 0`).
   - Verified DrawingML line fill `0000FF`.
5. **Text Character Spacing (`<a:rPr spc="...">`):**
   - Passed via `charSpacing: t.letterSpacing` into PptxGenJS text options, emitting `spc` attributes in the text run properties.
6. **Kurdish Sorani RTL Integrity:**
   - Cairo and Noto Sans Arabic fonts mapped with `rtlMode: true`, `lang: 'ku'`, and `algn="r"`.
   - Exact line pitch calculated in points (`<a:lnSpc><a:spcPts val="..."/>`), preventing line clipping in Canva.
7. **Strict Contract & Non-Silent Failure:**
   - Unsupported fonts throw validation errors (`Unsupported font: ComicSansMS_NotAllowed`) rather than silently flattening or degrading layout hierarchy.

---

## 3. Test Execution & Evidence

### 3.1 R08 Transfer Fidelity Test Suite
```bash
$ pnpm vitest run packages/creative/test/r08-transfer-fidelity.test.ts

 RUN  v4.1.11 /Users/hawzhin/Hawdesign

 ✓ packages/creative/test/r08-transfer-fidelity.test.ts (5 tests) 21ms
   ✓ R08 Transfer Fidelity & Feature Preservation (5)
     ✓ preserves exact audit fixture visual properties: ellipse, rotation, alpha, stroke, and text properties in DrawingML XML 12ms
     ✓ supports roundRect and line shapes with stroke and rotation 2ms
     ✓ preserves Kurdish Sorani RTL text blocks with Cairo font and right alignment 2ms
     ✓ supports direct encodeEditableTransfer with full geometry and formatting fidelity 3ms
     ✓ rejects unsupported fonts with clear validation errors instead of silent corruption 1ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  14:29:50
   Duration  240ms
```

### 3.2 Regression Suite Across Transfer Subsystems
```bash
$ pnpm vitest run packages/creative/test/transfer-v2.test.ts packages/creative/test/editable-transfer-rtl.test.ts

 RUN  v4.1.11 /Users/hawzhin/Hawdesign

 ✓ packages/creative/test/transfer-v2.test.ts (5 tests) 21ms
 ✓ packages/creative/test/editable-transfer-rtl.test.ts (2 tests) 13ms

 Test Files  2 passed (2)
      Tests  7 passed (7)
   Start at  14:29:53
   Duration  368ms
```

### 3.3 Audit Reproduction Probe (Defect F06 Counterexample Inversion)
Evaluating the exact audit fixture against the compiled package:
```javascript
const { encodeStudioTransferV2 } = await import('./dist/studio/transfer-v2.js');
const { unzipSync, strFromU8 } = await import('fflate');
const layout = {
  width: 1080, height: 1080, background: { color: '#FFFFFF' },
  grid: { margin: 40, columns: 12, gutter: 12, baseline: 8 },
  shapes: [{ kind: 'ellipse', x: 100, y: 100, width: 120, height: 120,
    color: '#FF0000', opacity: 0.2, rotation: 45, strokeWidth: 5, strokeColor: '#0000FF', role: 'accent' }],
  text: [{ copyIndex: 0, role: 'title', x: 100, y: 300, width: 800, height: 100,
    fontSize: 40, lineHeight: 1.3, fontFamily: 'Arial', color: '#000000', align: 'left', letterSpacing: 0.1, opacity: 0.3 }],
};
const encoded = await encodeStudioTransferV2(layout, ['Audit fixture']);
const xml = strFromU8(unzipSync(new Uint8Array(encoded.bytes))['ppt/slides/slide1.xml']);
```

**Result:**
| Property | Baseline Audit Value | Post-Remediation Value | DrawingML Evidence in PPTX |
|---|---|---|---|
| `ellipsePreserved` | `false` | **`true`** | `<a:prstGeom prst="ellipse">` |
| `rotationPreserved` | `false` | **`true`** | `rot="2700000"` (45°) |
| `shapeOpacityPreserved` | `false` | **`true`** | `<a:alpha val="20000"/>` (20% opacity) |
| `blueStrokePreserved` | `false` | **`true`** | Blue stroke `0000FF` with 3.75pt line width |
| `textOpacityPreserved` | `false` | **`true`** | `<a:alpha val="30000"/>` (30% opacity) |
| `textSpacingPreserved` | `false` | **`true`** | `<a:rPr spc="10">` |
| `manifestFidelity` | Divergent | **Identical** | Manifest plan matches encoded slide geometry |

---

## 4. Conclusion & Acceptance
Task R08 is **QUALIFIED and PROVED**. Defect F06 is fully remediated. Visual properties declared in Studio V2 and editable transfer plans are faithfully translated into DrawingML XML in PPTX exports, text editability is preserved with exact Kurdish RTL typography, and unsupported attributes fail visibly at the validation boundary rather than silently flattening into corrupted shapes.
