# Policy Questions & Operational Boundaries: Canva Integration for Hawa

**Audit Date:** 2026-09-11  
**Task:** CV-03  
**Status:** Resolved for architecture baseline  

This document details the operational answers to the 7 core integration questions governing Hawa's boundary with Canva.

---

### Question 1: Opening native Canva design, capturing PNG/PDF exports, and delivering approved files to Google Drive
- **Policy Answer:** Fully permitted and architecturally required.
- **Operational Boundary:** Hawa generates a verified Canva edit URL (`https://www.canva.com/design/<id>/edit`) tied to the specific task and client. The designer performs or refines the artwork natively in Canva. When complete, the designer downloads the export artifacts (PDF Print / PNG) or triggers an export action. Hawa ingests these files into its immutable artifact store (`evidence/` or task storage), computes cryptographically secure SHA-256 digests, runs preflight verification, collects client approval, and publishes the approved binary byte stream to Google Drive.
- **Critical Rule:** Hawa never uses a transient Canva download URL as a permanent client deliverable. Only immutable SHA-256-verified local artifact bytes are delivered.

---

### Question 2: Inspecting text, logo presence, page size, and exported-file quality for deliverable QA vs. external AI training
- **Policy Answer:** Permitted for deliverable QA; strictly prohibited for external model training.
- **Operational Boundary:** Reading design bounding boxes, text content, and verifying logo placement and color profiles is done strictly for task quality assurance (checking against client brand guidelines and brief specifications). These observations are stored locally in Hawa's PostgreSQL database (`hawa`). None of Canva's internal design assets, templates, or proprietary layouts may be fed to external LLM fine-tuning or training datasets.

---

### Question 3: Retaining original client-supplied guidelines independently and recording explicit user feedback
- **Policy Answer:** Governed client memory remains 100% inside Hawa and Obsidian vault.
- **Operational Boundary:** Hawa retains client knowledge bases (brand colors, typography rules, tone of voice, prohibited terms, past approved layouts) in its own repository and PostgreSQL schemas (`client_profiles`, `client_knowledge`). Canva is an execution canvas, not the system of record for client memory. Rejection feedback and approval notes stay in Hawa's governed learning audit logs.

---

### Question 4: Private internal integration route: Canva Enterprise vs. MCP vs. Apps SDK vs. Supervised Handoff
- **Policy Answer:** Multi-tier architectural selection:
  1. **Tier 1 (Immediate / Operational):** Supervised Native Canva Editor Handoff. Does not require Canva Enterprise or public app review. Fully supports all advanced features, Kurdish/Arabic typography, brand fonts, and PDF Print (CMYK + bleed).
  2. **Tier 2 (Automation Assistant):** Canva MCP for bounded transactional edits (updating existing copy, swapping assets, reading element geometry) where authorized.
  3. **Tier 3 (Future Custom Extension):** Canva Apps SDK sidebar application running inside the Canva editor, providing direct one-click Hawa brief synchronization.
  4. **Tier 4 (Blocked):** Canva Connect REST API private integration is marked `blocked` as it requires an enterprise subscription and corporate review. No silent subscription purchases are permitted.

---

### Question 5: Creating native editable elements, capturing consistent source versions, and detecting concurrent edits
- **Policy Answer:** Single-writer semantic transactions with conflict detection.
- **Operational Boundary:** In Canva MCP, editing transactions (`start_editing_transaction` -> `commit_editing_transaction`) provide optimistic locking. If a human edits the canvas while an AI transaction is open, Canva invalidates the transaction snapshot. Hawa must discard the draft, re-read the fresh canvas state, and alert the user. For manual human edits, Canva maintains internal cloud versioning, while Hawa captures timestamped, SHA-256 hashed export snapshots as the boundary truth.

---

### Question 6: Requesting CMYK PDF Print with explicit bleed and crop marks
- **Policy Answer:** Manual / Supervised native Canva download required for production print.
- **Operational Boundary:** Neither Canva Connect API nor Canva MCP nor Canva Apps SDK expose CMYK color space conversion, custom bleed margins, or crop mark generation. Only the native Canva Web Editor "Download -> PDF Print -> CMYK -> Crop marks and bleed" interface provides this. Therefore, print deliverables must be exported via native Canva UI and ingested into Hawa for automated preflight checks (pdftoppm, ghostscript / qpdf geometry verification).

---

### Question 7: Backing up and recovering complete editable native source independently of Canva
- **Policy Answer:** Canva cloud design ID is the editable master; offline vector files cannot be assumed to be editable backups.
- **Operational Boundary:** Experimental SVG export from Canva demonstrated that text elements are converted into outlined SVG vector paths (0 live text nodes). Importing complex SVGs into Canva results in flattened single-image elements. Therefore, an exported SVG is NOT an editable backup. True editable source recovery requires:
  1. Canva cloud design retention under the team account.
  2. Hawa preserving the structured brief, raw copy text, high-resolution original asset files (logos, imagery), and layout metadata in PostgreSQL so that any design can be cleanly reconstructed in Canva if necessary.
