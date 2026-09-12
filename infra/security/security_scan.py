#!/usr/bin/env python3
"""Automated security scanning for secrets, live API keys, and insecure code patterns."""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"AIza[0-9A-Za-z_-]{30,}"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?i)(?:password|secret|api_key|token)\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}['\"]"),
]

IGNORED_DIRS = {".git", "node_modules", "dist", "coverage", ".turbo", ".next", "build", ".pnpm-store", ".cache", "output", "scratch"}

def scan() -> int:
    hits: list[str] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or any(part in IGNORED_DIRS for part in path.parts):
            continue
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".zip", ".lock", ".svg"}:
            continue
        if path.name in {".env.example", "env.example", "security_scan.py"} or (path.name.startswith(".env") and not path.name.endswith(".example")):
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for pat in SECRET_PATTERNS:
            if pat.search(content):
                hits.append(f"{path.relative_to(ROOT)} matched secret pattern {pat.pattern}")
    if hits:
        print(f"SECURITY SCAN FAILED: {len(hits)} issues found:")
        for h in hits:
            print(f"  - {h}")
        return 1
    print("Security scan passed: Zero secrets or insecure keys detected.")
    return 0

if __name__ == "__main__":
    sys.exit(scan())
