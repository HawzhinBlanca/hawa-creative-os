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

## 2. Hard checks

### Facts and copy

- exact approved string comparison;
- protected token comparison for names, prices, dates, phone numbers, URLs, handles, claims, legal text;
- no unapproved model rewrite;
- correct locale and numeral policy;
- Unicode normalization recorded, not silently substituted in source text.

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

### Bidirectional behavior

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
