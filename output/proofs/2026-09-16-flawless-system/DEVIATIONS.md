# Deviations & Licensing Register: 2026-09-16 Flawless System

## Task F12: KAAE Typography Policy & Container Font Licensing

### 1. Status
- **Status:** NO DEVIATIONS / COMPLIANT
- **Blocked / Partial Items:** None. All F12 requirements are implemented and passing 100% of test suites.

### 2. Font Licensing & Container Redistribution Note
- **Verdana Licensing:**
  - Verdana is a proprietary typeface owned by Microsoft Corporation, designed by Matthew Carter.
  - It is natively provided on macOS and Windows workstations. On Debian/Ubuntu Linux distributions, it is accessible via the \`ttf-mscorefonts-installer\` package.
  - In headless container environments where commercial redistribution constraints prevent bundling proprietary TrueType binaries into third-party container images, **Canva PPTX/PDF export serves as the canonical render target**.
  - **Invariance Enforcement:** Under no circumstances will the local renderer silently substitute an unadmitted or generic serif/sans-serif font without explicit failure or declared draft status. All Canva exports verify actual run typefaces via \`checkCanvaPptx\`.

### 3. Open Font License (SIL OFL 1.1) Admitted Fonts
- The following Canva-native families bundled and referenced in the repository are governed by the SIL Open Font License 1.1, allowing open redistribution, bundling, and local rendering:
  - **Noto Sans Arabic** (Google Fonts / SIL OFL 1.1)
  - **Cinzel** (Google Fonts / Natanael Gama / SIL OFL 1.1)
  - **Playfair Display** (Google Fonts / Claus Eggers Sørensen / SIL OFL 1.1)
  - **Cairo** (Google Fonts / Mohamed Gaber / SIL OFL 1.1)
  - **Plus Jakarta Sans** (Google Fonts / Tokotype / SIL OFL 1.1)
  - **Vazirmatn** (Google Fonts / Saber Rastikerdar / SIL OFL 1.1)
  - **Inter** (Rasmus Andersson / SIL OFL 1.1)
