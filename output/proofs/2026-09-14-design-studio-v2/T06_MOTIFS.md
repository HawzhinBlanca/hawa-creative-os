# T06 Proof: Procedural Motifs Engine

- **Date / Timestamp**: 2026-09-14T09:40:00Z (12:40:00 local)
- **Branch**: `studio-v2`
- **Component**: `@hawa/creative` (`src/studio/motifs.ts`, `test/studio-motifs.test.ts`)

---

## 1. Specification & Mathematical Implementation

Per Sections 5.2 and 5.5 of `GEMINI_TASK_SHEET.md`, procedural motifs provide a deterministic, palette-compliant visual substrate for layouts that choose procedural art or as a safe fallback when generated imagery fails checks.

Four procedural motif algorithms are implemented in `packages/creative/src/studio/motifs.ts`:

1. **`guilloche`**:
   - Parametric hypotrochoid/epitrochoid harmonic spirograph curves:
     $$x(\theta) = (R - r)\cos(\theta) + d\cos\left(\frac{R - r}{r}\theta\right)$$
     $$y(\theta) = (R - r)\sin(\theta) - d\sin\left(\frac{R - r}{r}\theta\right)$$
   - Emits 3 to 5 multi-harmonic stroke layers in official KAAE Gold (`#F7B500`), Ice Blue (`#D4E2F0`), and Royal Navy (`#1E3A5F`).

2. **`sun-rays`**:
   - Radial geometric ray wedges emanating from a focal horizon ($y = 0.35 \times H$), evoking the Kurdish sun and academic enlightenment.
   - Alternating angular sectors with micro-opacities for subtle vector depth.

3. **`thin-rules`**:
   - High-precision architectural framing system: outer boundary rule, inset micro-dashed border, four `L`-shaped corner registration marks, and geometric grid division ticks.

4. **`gradient-wash`**:
   - Smooth multi-stop linear or radial gradient wash spanning Midnight Navy (`#0A1628`), Royal Navy (`#1E3A5F`), and KAAE Primary Blue (`#4770A3`).

---

## 2. Invariants & Verification

1. **Deterministic Execution**:
   - Powered by a seeded Mulberry32 pseudo-random generator.
   - Tests assert: `generateMotifSvg(type, seed)` is bit-for-bit identical across runs.

2. **Strict Palette Adherence**:
   - Every `fill`, `stroke`, and `stop-color` attribute is strictly drawn from the supplied brand palette.
   - Zero hardcoded colors; zero foreign or unapproved color values.

3. **Text-Free Guarantee**:
   - Automated tests scan output SVG and confirm zero `<text>` or `<tspan>` tags are emitted.

---

## 3. Artifact Manifest & Hashes (1080×1350 Canvas)

| Motif | Artifact File | Size (Bytes) | SHA-256 |
|---|---|---|---|
| `guilloche` | `guilloche.png` | 589,448 | `12e6588c9b95bb211aa9af88cf29853de75492d216e052abfaa683d4162a45b5` |
| `guilloche` | `guilloche.svg` | 34,101 | `3040dfdc2e3271321c421ae67088f9629ba50b45b75b792adb69b508666bff48` |
| `sun-rays` | `sun-rays.png` | 178,328 | `8620c00fc33e7c2a9aeddefafdcd3d08e1aad87bcfd8dce4f8d2f4dc2ac39eca` |
| `sun-rays` | `sun-rays.svg` | 3,105 | `9c7656aa18f0533dd9ed33b77482ba8c43227d0728faf224f0a3e7e4a76968fe` |
| `thin-rules` | `thin-rules.png` | 11,049 | `43076dc5ceba28b4ce4672b14b9ea915bc823186b5e37448d4e17a6141027cb3` |
| `thin-rules` | `thin-rules.svg` | 1,193 | `fea7658e8ec1ab7a2a610a367c7c429b441336724d1dab04ca77d3eece8c293f` |
| `gradient-wash` | `gradient-wash.png` | 9,512 | `89e9005b20ec82cfd3c49e2008aa0e1c5499007b1d20e0c77173a2dbf5522731` |
| `gradient-wash` | `gradient-wash.svg` | 518 | `4a724cd314d167ff0c4efe553ff4c4cab1dc4f81680fe9859edaba95fb344bc4` |

---

## 4. Test Suite Execution Output

```bash
pnpm vitest run packages/creative/test/studio-motifs.test.ts
```

```
 RUN  v4.1.11 /Users/hawzhin/Hawdesign

 ✓ packages/creative/test/studio-motifs.test.ts (16 tests) 171ms
     ✓ Motif: guilloche > is completely deterministic given a seed
     ✓ Motif: guilloche > contains zero <text> or <tspan> elements
     ✓ Motif: guilloche > uses ONLY palette colors and no foreign or unapproved colors
     ✓ Motif: guilloche > renders to valid 1x PNG buffer
     ✓ Motif: sun-rays > is completely deterministic given a seed
     ✓ Motif: sun-rays > contains zero <text> or <tspan> elements
     ✓ Motif: sun-rays > uses ONLY palette colors and no foreign or unapproved colors
     ✓ Motif: sun-rays > renders to valid 1x PNG buffer
     ✓ Motif: thin-rules > is completely deterministic given a seed
     ✓ Motif: thin-rules > contains zero <text> or <tspan> elements
     ✓ Motif: thin-rules > uses ONLY palette colors and no foreign or unapproved colors
     ✓ Motif: thin-rules > renders to valid 1x PNG buffer
     ✓ Motif: gradient-wash > is completely deterministic given a seed
     ✓ Motif: gradient-wash > contains zero <text> or <tspan> elements
     ✓ Motif: gradient-wash > uses ONLY palette colors and no foreign or unapproved colors
     ✓ Motif: gradient-wash > renders to valid 1x PNG buffer

 Test Files  1 passed (1)
      Tests  16 passed (16)
   Start at  12:40:07
   Duration  291ms
```
