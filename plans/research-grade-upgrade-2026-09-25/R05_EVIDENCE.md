# R05 — Blind comparison package boundary

**Date:** 2026-09-25. **Status:** in progress. No current Canva-export, multi-client human study has been run.

The existing `packageBlindPairs` accepted a nonexistent image path by substituting an empty buffer, then wrote that buffer as a `.png`. It could also overwrite an existing randomization key and rating sheet. The packager now validates all pairs before writing: it requires both files, distinct nonempty bytes, unique brief IDs, and a fresh key/sheet destination. Its image and private key files are created without overwrite with owner-only permissions. A missing second export is refused before the pair directory is created; an attempted second package in the same destination is refused.

The focused design-studio evaluation file passed **13 tests** after this change, including both negative controls, and the package TypeScript build passed. This only hardens a legacy packaging helper. It does **not** verify PNG decodability, Canva export origin, exact source/QC/deployment hashes, arm parity, three-rater blindness, signed corpus permissions, raw vote capture or brief-clustered confidence intervals. R05 remains open until a new package and analysis are bound to a human-reviewed R04 corpus and the exact current final exports.
