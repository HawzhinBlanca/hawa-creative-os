#!/usr/bin/env python3
"""Zero-secret-leakage gate.

Scans every file that git would commit (tracked plus untracked-but-not-ignored) for
credential material. Ignored paths (.env*, .hawa-state, output, dist, node_modules …)
are never scanned because they can never enter the repository; everything else is.

A hit is fatal unless it is listed in ``infra/security/secret_allowlist.txt`` with a
justification. The allowlist is exact-match on ``<relative path>|<pattern name>`` and
must explain why the string is not a live credential (test fixture, documented local
development default, …). Substring heuristics such as "the line mentions test" are
deliberately not accepted: a real key inside a test file is still a leaked key.

Run ``python3 infra/security/security_scan.py --self-test`` to prove the patterns
still detect each class of secret.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ALLOWLIST_PATH = ROOT / "infra" / "security" / "secret_allowlist.txt"

# (name, compiled pattern). Names are stable identifiers used by the allowlist.
SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("openai_or_anthropic_key", re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{30,}")),
    ("telegram_bot_token", re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b")),
    ("private_key_block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("postgres_url_with_password", re.compile(r"postgres(?:ql)?://[^\s:/@'\"]+:(?!REPLACE_|<|\$\{)[^\s@'\"]{4,}@")),
    ("hex_key_assignment", re.compile(r"(?i)\b[A-Z0-9_]*(?:KEY|SECRET|TOKEN)\b\s*[:=]\s*['\"][0-9a-f]{64}['\"]")),
    ("quoted_secret_assignment", re.compile(r"(?i)(?:password|passwd|secret|api_key|apikey|token)\b\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}['\"]")),
    ("compose_default_secret", re.compile(r"(?i)\$\{[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)[A-Z0-9_]*:-[^}\s]{8,}\}")),
    # e.g. `const ADMIN_KEY = '<39 chars>'` — long opaque values assigned to credential-named identifiers
    ("long_credential_assignment", re.compile(r"(?i)\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[:=]\s*['\"][A-Za-z0-9_\-]{32,}['\"]")),
    # e.g. `process.env.X || 'literal'` — an environment lookup with a hardcoded fallback credential
    ("env_fallback_literal", re.compile(r"process\.env\.[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*\|\|\s*['\"][A-Za-z0-9_\-]{16,}['\"]")),
    # e.g. `CREATE ROLE app LOGIN PASSWORD '<literal>'` — SQL puts no `=` or `:` before the value, so the
    # assignment patterns above miss it. Template (`'${…}'`) and placeholder values are not credentials.
    ("sql_password_literal", re.compile(r"(?i)\bPASSWORD\s+E?'(?!\$\{|REPLACE_|<)[^'\s]{8,}'")),
]

SKIP_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".zip", ".gz", ".pdf", ".woff", ".woff2", ".ttf", ".otf", ".pptx", ".lock"}
SKIP_NAMES = {"security_scan.py", "secret_allowlist.txt", "pnpm-lock.yaml"}


def committable_files() -> list[Path]:
    """Files git would include in a commit: tracked + untracked-not-ignored."""
    out = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-co", "--exclude-standard", "-z"],
        check=True, capture_output=True,
    ).stdout
    files: list[Path] = []
    for raw in out.split(b"\0"):
        if not raw:
            continue
        p = ROOT / raw.decode("utf-8", "surrogateescape")
        if p.is_file():
            files.append(p)
    return files


def load_allowlist() -> dict[str, str]:
    allow: dict[str, str] = {}
    if not ALLOWLIST_PATH.exists():
        return allow
    for line in ALLOWLIST_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|", 2)]
        if len(parts) != 3 or not parts[2]:
            raise SystemExit(f"secret_allowlist.txt: every entry needs '<path>|<pattern>|<justification>': {line!r}")
        allow[f"{parts[0]}|{parts[1]}"] = parts[2]
    return allow


def scan_files(files: list[Path], allow: dict[str, str]) -> tuple[list[str], list[str]]:
    hits: list[str] = []
    allowed: list[str] = []
    for path in files:
        if path.suffix.lower() in SKIP_SUFFIXES or path.name in SKIP_NAMES:
            continue
        # Environment files are gitignored; an .env that is NOT ignored is itself a leak.
        if path.name.startswith(".env") and not path.name.endswith(".example"):
            hits.append(f"{path.relative_to(ROOT)}|env_file_committable: environment files must be gitignored")
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        try:
            rel = str(path.relative_to(ROOT))
        except ValueError:
            rel = path.name
        for name, pattern in SECRET_PATTERNS:
            for match in pattern.finditer(content):
                line_no = content.count("\n", 0, match.start()) + 1
                key = f"{rel}|{name}"
                if key in allow:
                    allowed.append(f"{key} (line {line_no}): {allow[key]}")
                    continue
                hits.append(f"{rel}:{line_no} {name}")
                break  # one report per pattern per file is enough
    return hits, allowed


def scan() -> int:
    allow = load_allowlist()
    hits, allowed = scan_files(committable_files(), allow)
    unused = [k for k in allow if not any(a.startswith(k + " ") for a in allowed)]
    if hits:
        print(f"SECURITY SCAN FAILED: {len(hits)} committable file(s) contain credential material:")
        for h in hits:
            print(f"  - {h}")
        return 1
    if unused:
        print("SECURITY SCAN FAILED: stale allowlist entries (remove them so the gate stays honest):")
        for k in unused:
            print(f"  - {k}")
        return 1
    print(f"Security scan passed: 0 secrets in committable files; {len(allowed)} justified allowlist hit(s).")
    for a in allowed:
        print(f"  allow: {a}")
    return 0


def self_test() -> int:
    """Prove each pattern fires on a planted fixture and stays quiet on benign text."""
    fixtures = {
        "openai_or_anthropic_key": "key = 'sk-ant-api03-" + "A" * 40 + "'",
        "google_api_key": "AIza" + "B" * 35,
        "telegram_bot_token": "1234567890:" + "C" * 35,
        "private_key_block": "-----BEGIN PRIVATE KEY-----",
        "postgres_url_with_password": "postgresql://hawa_app:someRuntimePassword@postgres:5432/hawa",
        "hex_key_assignment": "const CANVA_TOKEN_ENCRYPTION_KEY = '" + "ab" * 32 + "';",
        "quoted_secret_assignment": "webhook_secret: 'office_secret_production_entropy_99f3b817'",
        "compose_default_secret": "TELEGRAM_WEBHOOK_SECRET: ${TELEGRAM_WEBHOOK_SECRET:-office_secret_production_entropy}",
        "long_credential_assignment": "const ADMIN_KEY = 'hawa_admin_" + "Q" * 40 + "';",
        "env_fallback_literal": "const k = process.env.HAWA_ADMIN_KEY || 'hawa_admin_fallback_value_123';",
        "sql_password_literal": "    CREATE ROLE hawa_test_app WITH LOGIN PASSWORD 'n0tARealRoleSecret4fixture';",
    }
    benign = (
        "const url = process.env.DATABASE_URL; // postgresql://user@host/db\nTOKEN = os.environ['TOKEN']\nvalue: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}\n"
        "ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${credentials.appPassword}';\n"
        "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'hawa_user', :'hawa_password') \\gexec\n"
        "ALTER ROLE hawa_app PASSWORD '<new-password>';\n"
    )
    failures = 0
    for name, pattern in SECRET_PATTERNS:
        if not pattern.search(fixtures[name]):
            print(f"self-test FAILED: {name} did not match its fixture")
            failures += 1
        if pattern.search(benign):
            print(f"self-test FAILED: {name} matched benign text")
            failures += 1
    with tempfile.TemporaryDirectory() as tmp:
        planted = Path(tmp) / "planted.ts"
        planted.write_text("\n".join(fixtures.values()), encoding="utf-8")
        hits, _ = scan_files([planted], {})
        if len(hits) != len(SECRET_PATTERNS):
            print(f"self-test FAILED: planted file produced {len(hits)} hits, expected {len(SECRET_PATTERNS)}")
            failures += 1
    if failures:
        return 1
    print(f"self-test passed: {len(SECRET_PATTERNS)} patterns detect their fixtures and ignore benign text.")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    sys.exit(scan())
