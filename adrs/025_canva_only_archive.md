# ADR 025 — Canva-only active studio, archived alternatives
Date: 2026-09-13. Status: accepted by explicit user instruction.

User requires Canva as the only editing/export studio and asks to archive Figma and alternatives. This implements FR-030, FR-064, FR-073–075, FR-080 and CV-23. It supersedes historical HyCanvas/Figma selection and rollback-to-alternative-provider advice in earlier documents, without endorsing their past qualification claims.

Move retired adapters, bridge contracts/repositories, dedicated tests/scripts and deployment artifacts outside active source/build/test discovery. Preserve checksums and relative paths. Remove application exports and provider routing values. Keep database schema fields and historical import metadata so old records remain readable; do not rename or erase historical designs. Compatibility URLs return 410 and cannot invoke an alternative. No archive is copied into Docker images. Test-only neutral fixtures are not production providers or capability evidence.

Canva remains the only external studio. Telegram/WhatsApp intake, PostgreSQL, Restate, AI planning, brand references and validation remain part of Hawa. Source PPTX encoding is a Canva interchange boundary, not a second user editor. This retirement does not qualify visual design quality or unfinished Telegram completion notifications.
