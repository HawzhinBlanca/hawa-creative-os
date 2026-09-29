# Bounded specification traversal — 2026-09-29

Requirements: NFR-012 and NFR-024, MASTER_SPEC.md and the existing release verification contract.

The package validator and manifest generator used repeated recursive scans of the entire checkout before applying their exclusions. A real commit attempt was stopped in that traversal after its secret scan passed. Host load was also exceptionally high (load average above 200 on 14 logical CPUs), so elapsed time is not a controlled performance benchmark.

Both tools now share a sorted file traversal that prunes only top-level excluded directories and names excluded at every depth. File-based rules remain unchanged; nested configuration examples and nested directories named node_modules outside the top-level exclusion remain included. Directory symlinks are not followed. Unreadable included directories fail rather than silently disappearing from a release scan. No validation assertion or secret pattern was removed.

Verification: four Python regression tests pass, covering legacy file-set equivalence, forbidden traversal, symlink loops/file links and unreadable included directories. Command: `python3 scripts/test_pack_walk.py`. Full repository validation and release checks follow this change; this document does not assert production admission.
