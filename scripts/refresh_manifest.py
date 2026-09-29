#!/usr/bin/env python3
"""Regenerate MANIFEST.json and SHA256SUMS.txt from the package files on disk.

Uses exactly the same inclusion rules as scripts/validate_pack.py so that
``python3 scripts/refresh_manifest.py && python3 scripts/validate_pack.py`` is
always self-consistent. The manifest is a machine artifact; never hand-edit it.
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from validate_pack import package_files  # noqa: E402  (same traversal as the validator)

MANIFEST = ROOT / "MANIFEST.json"
SUMS = ROOT / "SHA256SUMS.txt"
SELF_EXCLUDED = {MANIFEST.name, SUMS.name, "VALIDATION_REPORT.md"}


def main() -> int:
    files = package_files()
    prior = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}
    entries = []
    for path in files:
        if path.name in SELF_EXCLUDED:
            continue
        entries.append({"path": str(path.relative_to(ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size})
    prior_entries = prior.get("files", [])
    files_changed = entries != prior_entries
    generated_at = (
        datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        if files_changed or "generatedAt" not in prior
        else prior["generatedAt"]
    )
    manifest = {
        "schemaVersion": prior.get("schemaVersion", "1.0.0"),
        "package": prior.get("package", "hawa-creative-os-blueprint"),
        "specificationVersion": prior.get("specificationVersion", "1.0.0"),
        "researchFreeze": prior.get("researchFreeze", "2026-09-03"),
        "generatedAt": generated_at,
        "hashAlgorithm": "SHA-256",
        "exclusions": [
            "MANIFEST.json (self-reference)",
            "SHA256SUMS.txt (self-reference)",
            "VALIDATION_REPORT.md (final validation record, covered by SHA256SUMS.txt)",
        ],
        "fileCount": len(entries),
        "files": entries,
    }
    # Write the manifest first: SHA256SUMS.txt must record the digest of the manifest as published.
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    sums_lines = []
    for path in package_files():
        if path.name == SUMS.name:
            continue
        sums_lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(ROOT)}")
    SUMS.write_text("\n".join(sums_lines) + "\n", encoding="utf-8")
    print(f"MANIFEST.json: {len(entries)} entries; SHA256SUMS.txt: {len(sums_lines)} lines")
    return 0


if __name__ == "__main__":
    sys.exit(main())
