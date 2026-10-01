# Quality Assurance, Sorani, Arabic, and RTL

## 1. QA layers

```text
Q0 input/fact lock
Q1 source schema and asset integrity
Q2 exact copy and language normalization
Q3 dimensions/layout/font/bidi checks
Q4 brand and task-requirement checks
Q5 rendered-image technical checks
Q6 independent visual-model review
Q7 human native/design review
Q8 publication/source-package verification
```

A design passes only when every required hard gate passes.

### Mandatory local text measurements (ADR-117)

Studio records measured geometry or an explicit unmeasured reason for every required
copy block. Missing/blank content, unavailable fonts, missing visible primary-face
glyphs, invalid inputs and shaping failures cannot inherit guessed geometry.
`COPY_UNMEASURED` refuses local QA and optional artwork in either pipeline; V3
selection also excludes it. Final QA retains copy/font/input hashes and measurements
for the selected candidate, including a replacement winner, and honors selection holds.

A primary font may lack Latin letters or symbols which the rasterizer draws through
fallback. ADR-118 measures those runs through the pinned Pango environment, retaining
actual face hashes, implementation identity, line advances, ink bounds and unknown
glyphs. Preparation, SVG placement and transfer fitting share that wrapper. Missing
helper, invalid/unpinned evidence or unknown glyphs refuse fit; no primary-face
estimate is substituted. Symbol subsets include spaces needed inside fallback runs.
Local rasterizer agreement does not replace native Canva, bidi or human-language
inspection. Primary-only fontkit checks remain conservative, including nominal
eyebrow size before optional fitting.

## 2. Hard checks

### Facts and copy

- exact approved string comparison;
- protected token comparison for names, prices, dates, phone numbers, URLs, handles, claims, legal text;
- no unapproved model rewrite;
- correct locale and numeral policy;
- Unicode normalization recorded, not silently substituted in source text.

Transfer language metadata comes from explicitly labelled saved copy fields, independently of
font and direction. Unknown language is `und`; Arabic script does not establish Arabic versus
Sorani, and historical script-derived `exactCopy.language` labels are not authoritative.
The import manifest records one validated language tag per exact-copy index. Studio binds
known labels to the copy's SHA-256 and discards the label after a wording change. These source
tags do not establish native Canva preservation, shaping, normalization or visual quality.

### Source/editability

- real Canva design ID, captured source metadata and export bound to the pinned revision;
- every required factual element is live text/vector/official asset;
- source round-trip succeeds;
- required assets/fonts available and hashed;
- no accidental flattening;
- source/manifest/preview revision consistency.

### Layout

- exact artboard sizes and variants;
- text boxes not overflowed/clipped;
- safe zones and margins;
- minimum font sizes by format;
- logo/sponsor clear space and distortion;
- contrast rules where mandatory;
- crop/focal constraints;
- export dimensions/MIME/size.

## 3. Sorani/Arabic validation

### Character and font coverage

For every text run:

- resolve the exact font file/style;
- verify glyph coverage for every code point;
- verify no unexpected fallback;
- detect missing glyph/tofu output;
- preserve joining behavior and diacritics;
- compare browser and server-renderer font versions.

### Captured font declarations (ADR208)

Inspect the explicit Latin/Arabic font slot used by each regular run and text
field. An expected family in an unused slot does not qualify the actual text;
mixed runs must satisfy each used script. Formal mixed-body runs retain their
individual script families. Missing or conflicting used-slot declarations refuse.
Retained field text is inspected at capture time; future field updates, native
glyph shaping and editability remain separate unqualified capabilities.

### Bidirectional behavior

Studio must respect explicit `rtl:false` even with an Arabic-script font. Legacy
font-based direction fallback applies only when direction is unspecified. Cursive
tracking and line spacing are typography rules, independent of paragraph direction.
Canva may omit LTR attributes; absent metadata is not positive rendering evidence.

Golden tests include:

- pure Sorani and Arabic;
- mixed Sorani/English and Arabic/English;
- Latin/Arabic-Indic/extended Arabic-Indic digits;
- currency, dates, times, phone numbers;
- hashtags, usernames, URLs, email addresses;
- punctuation and quotation marks;
- parentheses/brackets around opposite-direction text;
- bold/color/style boundaries across RTL runs;
- multiline wrapping and right alignment;
- emoji and symbols;
- narrow story layouts;
- copied text versus typed text;
- explicit direction versus auto direction.

Canva's actual native edit and final export are the subject of these proof tests. Isolate controls, paired brackets, mixed style runs, glyph fallback and Sorani punctuation must be inspected in the captured export and by a native reader. If inspection is unavailable, the result is unknown and requires operator review; another renderer's success does not establish Canva export fidelity.

ADR-082 separates paragraph direction metadata from rendered bidi/isolation. Inspect
every paragraph and both XML boolean spellings; pin explicit source directions with
the export checking policy. An explicit conflict or malformed value fails. Mixed
text without a saved direction stays unspecified. Matching flags still require the
hash-bound visual assertion for Arabic/Sorani approval. Retain source language
provenance: real Canva exports rewrite language tags and cannot establish it.

## 4. Spelling and terminology

No current generic checker is accepted as authoritative for Sorani.

Use:

- client-approved glossary;
- office terminology database;
- protected names/phrases;
- optional dictionary suggestions;
- model review as advisory;
- native-speaker approval for all Sorani during MVP.

Arabic may use additional language-tooling, but exact approved copy still outranks automated correction.

## 5. Visual QA

The independent judge receives:

- rendered candidate;
- locked brief;
- Client DNA digest;
- relevant approved examples;
- hard-QA results;
- a fixed rubric.

It returns structured findings with region/node evidence, severity, confidence, and repair suggestion.

It cannot:

- approve work;
- override hard failures;
- change client/project;
- change exact copy;
- publish;
- activate learned rules.

## 6. Machine-image checks

Use deterministic image analysis for:

- corrupt/blank output;
- dimensions/aspect ratio;
- alpha/background expectations;
- effective resolution;
- extreme blur/compression;
- clipping to canvas;
- large unintended empty regions;
- near-duplicate candidates;
- mismatch against expected logo/QR hashes where pixel comparison is appropriate.

OCR is secondary evidence only, especially for Sorani. The source text layer is the authoritative comparison.

## 7. Severity

| Severity | Meaning | Behavior |
|---|---|---|
| Critical | wrong client, factual copy, missing source, permission, official asset, unreadable RTL | block immediately |
| High | major requirement, overflow, illegibility, broken composition, obvious artefact | block or repair |
| Medium | quality/style issue likely to trigger revision | warn and normally human review |
| Low | optional polish | non-blocking evidence |

## 8. Auto-repair policy

Only findings with a bounded repair may be automated. The repair command must target explicit nodes/assets and preserve locked elements.

After two cycles, route to human review with the complete failure chain.

## 9. Golden baselines

- 40 supplied synthetic/mixed-direction cases;
- at least 20 real office Sorani designs;
- at least 10 Arabic and 10 mixed-language real designs;
- multiple fonts approved by the office;
- browser, editor, and every required export path;
- visual snapshots and extracted semantic text.

Critical tests require exact semantic equality and human visual pass. Pixel differences use a declared tolerance only for anti-aliasing/render-engine variation.

## 10. Release gate

No studio, font update, browser/runtime update, or render-engine update reaches production until the full multilingual golden suite passes on the exact deployment image.
