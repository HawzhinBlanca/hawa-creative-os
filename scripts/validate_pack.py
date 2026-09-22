#!/usr/bin/env python3
"""Validate the Hawa Creative OS specification package without network access."""
from __future__ import annotations

import csv
import hashlib
import html.parser
import json
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"PyYAML is required to validate YAML: {exc}")

ROOT = Path(__file__).resolve().parents[1]
FAILURES: list[str] = []
WARNINGS: list[str] = []
PASSES: list[str] = []

IGNORED_TOP_LEVEL = {
    # .worktrees holds other agents' checkouts, each with its own node_modules; the deploy
    # pre-flight walked into one on 2026-09-22 and reported 10,623 failures against vendor READMEs.
    ".git", ".claude", ".worktrees", "node_modules", "dist", "coverage", ".turbo", ".next", "build",
    ".pnpm-store", ".cache", "evidence", "apps", "packages", "services", "infra", "vendor", "output",
    "exports", "hawdesign-creative-os-figma-agent-studio", ".tmp_render_figma",
    "scratch", ".hawa-state", "data", "archive"
}
IGNORED_ANYWHERE = {"__pycache__", ".DS_Store"}
WORKSPACE_ROOT_FILES = {
    ".gitignore", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml",
    "tsconfig.json", "tsconfig.base.json", "vitest.config.ts", "vitest.workspace.ts"
}

def should_skip(path: Path) -> bool:
    try:
        rel = path.relative_to(ROOT)
    except Exception:
        return False
    if any(part in IGNORED_ANYWHERE for part in rel.parts):
        return True
    if rel.name.startswith(".env") and not rel.name.endswith(".example"):
        return True
    if rel.parts and rel.parts[0] in IGNORED_TOP_LEVEL:
        return True
    if rel.parts and rel.parts[0] == "config" and len(rel.parts) > 1 and not rel.name.endswith((".example.yaml", ".example.json")):
        return True
    if path.suffix == ".pyc":
        return True
    if len(rel.parts) == 1 and rel.parts[0] in WORKSPACE_ROOT_FILES:
        return True
    return False


def ok(message: str) -> None:
    PASSES.append(message)


def fail(message: str) -> None:
    FAILURES.append(message)


def warn(message: str) -> None:
    WARNINGS.append(message)


def require(condition: bool, message: str) -> None:
    (ok if condition else fail)(message)


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except Exception as exc:
            fail(f"{path.relative_to(ROOT)} line {number} is valid JSON: {exc}")
            continue
        if not isinstance(item, dict):
            fail(f"{path.relative_to(ROOT)} line {number} is an object")
            continue
        rows.append(item)
    return rows


def unique_ids(rows: list[dict[str, Any]], key: str, label: str) -> set[str]:
    values = [str(row.get(key, "")) for row in rows]
    duplicates = sorted(k for k, n in Counter(values).items() if not k or n > 1)
    require(not duplicates, f"{label} has unique non-empty {key} values" + (f"; bad={duplicates[:10]}" if duplicates else ""))
    return set(values)


def validate_required_files() -> None:
    required = [
        "README.md", "DECISION_SUMMARY.md", "MASTER_SPEC.md", "AI_BUILD_PROMPT.md",
        "AGENTS.md", "DOCUMENT_INDEX.md", "LICENSE_NOTICE.md", "api/openapi.yaml",
        "db/schema.sql", "db/rls.sql", "db/seed.sql", "plans/requirements.csv",
        "plans/traceability.csv", "plans/backlog.csv", "plans/user-stories.csv",
        "docs/21_HYCANVAS_PROOF_SPRINT.md", "docs/29_ACCEPTANCE_GATES.md",
        "ui/wireframes.html", "deployment/docker-compose.yml",
    ]
    missing = [p for p in required if not (ROOT / p).is_file()]
    require(not missing, "all mandatory package files exist" + (f"; missing={missing}" if missing else ""))
    for directory in ("docs", "adrs", "db", "api", "contracts", "schemas", "evals", "prompts", "deployment", "runbooks", "plans", "ui", "scripts"):
        require((ROOT / directory).is_dir(), f"directory {directory}/ exists")


def validate_requirements() -> None:
    reqs = read_csv(ROOT / "plans/requirements.csv")
    req_ids = unique_ids(reqs, "id", "requirements")
    types = Counter(row.get("type") for row in reqs)
    require(types["FR"] >= 80, f"functional requirements >= 80 (actual {types['FR']})")
    require(types["NFR"] >= 25, f"non-functional requirements >= 25 (actual {types['NFR']})")
    require(len(reqs) == types["FR"] + types["NFR"], "every requirement is FR or NFR")
    require(all(row.get("requirement", "").strip() for row in reqs), "every requirement has normative text")

    trace = read_csv(ROOT / "plans/traceability.csv")
    trace_ids = unique_ids(trace, "requirement_id", "traceability")
    require(trace_ids == req_ids, "traceability covers exactly every requirement")
    require(all((ROOT / row["source_document"]).is_file() for row in trace), "every traceability source document exists")
    require(all(row.get("test_id", "").startswith("TEST-") for row in trace), "every requirement has a stable test ID")
    require(all(row.get("acceptance_evidence", "").strip() for row in trace), "every requirement defines acceptance evidence")

    stories = read_csv(ROOT / "plans/user-stories.csv")
    unique_ids(stories, "id", "user stories")
    require(len(stories) >= 40, f"user stories >= 40 (actual {len(stories)})")

    backlog = read_csv(ROOT / "plans/backlog.csv")
    unique_ids(backlog, "id", "backlog")
    require(len(backlog) >= 80, f"backlog items >= 80 (actual {len(backlog)})")
    bad_refs: list[str] = []
    for row in backlog:
        for rid in filter(None, (x.strip() for x in row.get("requirement_ids", "").split(";"))):
            if rid not in req_ids:
                bad_refs.append(f"{row.get('id')}->{rid}")
    require(not bad_refs, "backlog requirement references are valid" + (f"; bad={bad_refs[:10]}" if bad_refs else ""))

    risks = read_csv(ROOT / "plans/risk-register.csv")
    unique_ids(risks, "id", "risk register")
    require(len(risks) >= 30, f"risk register entries >= 30 (actual {len(risks)})")
    require(all(row.get("mitigation") and row.get("contingency") and row.get("owner") for row in risks), "every risk has owner, mitigation, and contingency")


def validate_evaluations() -> None:
    targets = {
        "routing_brief.jsonl": 60,
        "rtl_golden_cases.jsonl": 40,
        "retrieval_eval.jsonl": 20,
    }
    for filename, minimum in targets.items():
        rows = read_jsonl(ROOT / "evals" / filename)
        unique_ids(rows, "id", filename)
        require(len(rows) >= minimum, f"{filename} has at least {minimum} cases (actual {len(rows)})")

    routing = read_jsonl(ROOT / "evals/routing_brief.jsonl")
    require(any(row.get("expected", {}).get("must_abstain") for row in routing), "routing corpus includes abstention cases")
    require({row.get("language") for row in routing} >= {"en", "ckb", "ar"}, "routing corpus includes English, Sorani, and Arabic")

    rtl = read_jsonl(ROOT / "evals/rtl_golden_cases.jsonl")
    require({row.get("language") for row in rtl} >= {"en", "ckb", "ar"}, "RTL corpus includes English, Sorani, and Arabic")
    require(sum(bool(row.get("critical")) for row in rtl) >= 20, "RTL corpus contains at least 20 critical cases")

    faults = read_csv(ROOT / "evals/fault_injection_matrix.csv")
    unique_ids(faults, "id", "fault injection matrix")
    require(len(faults) >= 36, f"fault scenarios >= 36 (actual {len(faults)})")
    require(all(row.get("expected_safe_behavior") and row.get("evidence") for row in faults), "every fault scenario defines invariant and evidence")

    model_matrix = yaml.safe_load((ROOT / "evals/model_eval_matrix.yaml").read_text(encoding="utf-8"))
    require(isinstance(model_matrix, dict), "model evaluation matrix parses as a mapping")
    require(len(model_matrix.get("roles", {})) >= 8, "model evaluation matrix defines at least eight roles")
    require("promotion" in model_matrix and "hard_gates" in model_matrix, "model evaluation matrix defines promotion and hard gates")


def validate_schemas_and_api() -> None:
    schemas = sorted((ROOT / "schemas").glob("*.json"))
    require(len(schemas) >= 10, f"at least 10 JSON Schemas exist (actual {len(schemas)})")
    ids: set[str] = set()
    for path in schemas:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            fail(f"{path.relative_to(ROOT)} parses as JSON: {exc}")
            continue
        require(data.get("$schema") == "https://json-schema.org/draft/2020-12/schema", f"{path.name} uses JSON Schema 2020-12")
        require(isinstance(data.get("$id"), str) and bool(data["$id"]), f"{path.name} has a stable $id")
        if data.get("$id") in ids:
            fail(f"{path.name} has a unique $id")
        ids.add(data.get("$id", ""))
        require(data.get("type") == "object", f"{path.name} defines an object contract")
        require(data.get("additionalProperties") is False, f"{path.name} rejects undeclared top-level fields")

    try:
        api = yaml.safe_load((ROOT / "api/openapi.yaml").read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"OpenAPI parses as YAML: {exc}")
        return
    require(str(api.get("openapi", "")).startswith("3.1"), "OpenAPI contract is version 3.1.x")
    require(len(api.get("paths", {})) >= 15, f"OpenAPI has at least 15 paths (actual {len(api.get('paths', {}))})")
    require("components" in api and "schemas" in api["components"], "OpenAPI defines component schemas")
    operations: list[str] = []
    for _, item in api.get("paths", {}).items():
        if not isinstance(item, dict):
            continue
        for method, op in item.items():
            if method.lower() in {"get", "post", "put", "patch", "delete"} and isinstance(op, dict):
                operations.append(str(op.get("operationId", "")))
    require(all(operations), "every HTTP operation has an operationId")
    require(len(operations) == len(set(operations)), "OpenAPI operationIds are unique")


def validate_sql() -> None:
    schema = (ROOT / "db/schema.sql").read_text(encoding="utf-8")
    rls = (ROOT / "db/rls.sql").read_text(encoding="utf-8")
    require("CREATE EXTENSION IF NOT EXISTS vector" in schema, "database enables pgvector explicitly")
    require("CREATE EXTENSION IF NOT EXISTS pg_trgm" in schema, "database enables trigram search explicitly")
    create_tables = re.findall(r"CREATE TABLE(?: IF NOT EXISTS)?\s+([\w.\"]+)", schema, flags=re.I)
    require(len(create_tables) >= 35, f"database defines at least 35 tables (actual {len(create_tables)})")
    require(len(create_tables) == len(set(create_tables)), "database table declarations are unique")
    require("ENABLE ROW LEVEL SECURITY" in rls, "RLS file enables row-level security")
    require("CREATE POLICY" in rls, "RLS file defines policies")
    require("current_setting('app.user_id'" in rls, "RLS binds authorization to transaction-local application identity")
    require(not re.search(r"UNIQUE\s*\([^;)]*COALESCE", schema, flags=re.I | re.S), "SQL avoids expression UNIQUE table constraints")
    require("append_only" in schema.lower() or "prevent_" in schema.lower(), "database includes append-only/audit mutation protection")
    # Lightweight delimiter checks; PostgreSQL execution remains a clean-host gate.
    require(schema.count("(") == schema.count(")"), "schema.sql parentheses are balanced")
    require(rls.count("(") == rls.count(")"), "rls.sql parentheses are balanced")


def validate_contracts() -> None:
    contracts = sorted((ROOT / "contracts").glob("*.ts"))
    require(len(contracts) >= 8, f"at least 8 TypeScript adapter contracts exist (actual {len(contracts)})")
    require(all(path.stat().st_size > 500 for path in contracts), "every TypeScript contract is substantive")
    if not shutil_which("tsc"):
        warn("tsc unavailable; contract type check skipped")
        return
    config = {
        "compilerOptions": {
            "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
            "strict": True, "noEmit": True, "skipLibCheck": True,
            "forceConsistentCasingInFileNames": True,
        },
        "include": [str(ROOT / "contracts" / "**" / "*.ts")],
    }
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "tsconfig.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        result = subprocess.run(["tsc", "-p", str(path)], capture_output=True, text=True, timeout=60)
    require(result.returncode == 0, "TypeScript contracts pass strict tsc" + (f"; {result.stdout}{result.stderr}" if result.returncode else ""))


def shutil_which(name: str) -> str | None:
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        candidate = Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def validate_yaml_and_config() -> None:
    yaml_files = sorted([p for p in [*ROOT.rglob("*.yaml"), *ROOT.rglob("*.yml")] if not should_skip(p)])
    for path in yaml_files:
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
            require(data is not None, f"{path.relative_to(ROOT)} parses as non-empty YAML")
        except Exception as exc:
            fail(f"{path.relative_to(ROOT)} parses as YAML: {exc}")
    compose = yaml.safe_load((ROOT / "deployment/docker-compose.yml").read_text(encoding="utf-8"))
    services = set(compose.get("services", {}))
    require({"caddy", "app", "migrate", "postgres", "restate", "phoenix", "comfyui", "retrieval-worker"} <= services, "Compose declares every selected deployable service")
    if "hycanvas" in compose.get("services", {}):
        require(compose["services"]["hycanvas"].get("profiles") == ["studio-hycanvas"], "HyCanvas is disabled until its admission profile is enabled")
    require(compose["networks"]["core"].get("internal") is True, "core Compose network is internal")
    require(compose["networks"]["gpu_jobs"].get("internal") is True, "GPU worker network is internal")


def validate_markup_and_diagrams() -> None:
    class Parser(html.parser.HTMLParser):
        pass
    parser = Parser()
    try:
        parser.feed((ROOT / "ui/wireframes.html").read_text(encoding="utf-8"))
        ok("wireframes HTML parses")
    except Exception as exc:
        fail(f"wireframes HTML parses: {exc}")
    html_text = (ROOT / "ui/wireframes.html").read_text(encoding="utf-8")
    require("http://" not in html_text and "https://" not in html_text, "wireframes are self-contained with no remote runtime assets")
    require(html_text.lower().count("<section") >= 6, "wireframes contain at least six principal screen sections")

    for path in sorted((ROOT / "diagrams").glob("*.svg")):
        try:
            ET.parse(path)
            ok(f"{path.relative_to(ROOT)} parses as SVG/XML")
        except Exception as exc:
            fail(f"{path.relative_to(ROOT)} parses as SVG/XML: {exc}")
    require(len(list((ROOT / "diagrams").glob("*.mmd"))) >= 4, "at least four Mermaid diagram sources exist")
    require(len(list((ROOT / "diagrams").glob("*.dot"))) >= 4, "at least four Graphviz diagram sources exist")


def validate_documents() -> None:
    markdown = sorted([p for p in ROOT.rglob("*.md") if not should_skip(p)])
    require(len(markdown) >= 55, f"at least 55 Markdown documents exist (actual {len(markdown)})")
    empty = [str(p.relative_to(ROOT)) for p in markdown if p.stat().st_size < 100]
    require(not empty, "no Markdown document is trivially empty" + (f"; bad={empty}" if empty else ""))

    forbidden = re.compile(r"\b(?:TODO|TBD|FIXME|XXX)\b", re.I)
    hits: list[str] = []
    broken: list[str] = []
    link_re = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
    for path in markdown:
        text = path.read_text(encoding="utf-8")
        if forbidden.search(text):
            hits.append(str(path.relative_to(ROOT)))
        for match in link_re.finditer(text):
            target = match.group(1).split("#", 1)[0].strip()
            if not target or target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            if not (path.parent / target).resolve().exists():
                broken.append(f"{path.relative_to(ROOT)}->{target}")
    require(not hits, "documents contain no TODO/TBD/FIXME placeholders" + (f"; bad={hits}" if hits else ""))
    require(not broken, "all local Markdown links resolve" + (f"; bad={broken[:20]}" if broken else ""))

    prompt_files = sorted((ROOT / "prompts").glob("*.md"))
    require(len(prompt_files) >= 6, "at least six versioned prompt contracts exist")
    require(all(p.stat().st_size >= 500 for p in prompt_files), "every prompt contract is substantive")
    require((ROOT / "AI_BUILD_PROMPT.md").stat().st_size >= 12000, "AI build prompt is complete and substantive")


def validate_security_hygiene() -> None:
    forbidden_extensions = {".ttf", ".otf", ".woff", ".woff2", ".eot"}
    font_files = [str(p.relative_to(ROOT)) for p in ROOT.rglob("*") if p.is_file() and not should_skip(p) and p.suffix.lower() in forbidden_extensions]
    require(not font_files, "package contains no redistributed font binaries")

    secret_patterns = [
        re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}"),
        re.compile(r"AIza[0-9A-Za-z_-]{30,}"),
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    ]
    hits: list[str] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or should_skip(path) or path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".zip"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if any(pattern.search(text) for pattern in secret_patterns):
            hits.append(str(path.relative_to(ROOT)))
    require(not hits, "package contains no obvious live API keys/private keys" + (f"; bad={hits}" if hits else ""))

    absolute_hits: list[str] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or should_skip(path) or path.name == "validate_pack.py":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if "/home/oai/" in text or "/mnt/data/" in text:
            absolute_hits.append(str(path.relative_to(ROOT)))
    require(not absolute_hits, "package contains no environment-specific working paths" + (f"; bad={absolute_hits}" if absolute_hits else ""))


def validate_manifest() -> None:
    path = ROOT / "MANIFEST.json"
    sums_path = ROOT / "SHA256SUMS.txt"
    if not path.exists() or not sums_path.exists():
        warn("MANIFEST.json/SHA256SUMS.txt not present during pre-integrity validation")
        return
    manifest = json.loads(path.read_text(encoding="utf-8"))
    entries = manifest.get("files", [])
    require(isinstance(entries, list) and entries, "manifest contains file entries")
    for entry in entries:
        rel = entry["path"]
        target = ROOT / rel
        if not target.is_file():
            fail(f"manifest target exists: {rel}")
            continue
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        require(digest == entry["sha256"], f"manifest hash matches {rel}")
        require(target.stat().st_size == entry["bytes"], f"manifest size matches {rel}")
    sum_lines = [line for line in sums_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    parsed: dict[str, str] = {}
    for line in sum_lines:
        digest, rel = line.split("  ", 1)
        parsed[rel] = digest
    expected = [p for p in ROOT.rglob("*") if p.is_file() and p != sums_path and not should_skip(p)]
    require(set(parsed) == {str(p.relative_to(ROOT)) for p in expected}, "SHA256SUMS covers every package file except itself")
    for target in expected:
        rel = str(target.relative_to(ROOT))
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if parsed.get(rel) != digest:
            fail(f"SHA256SUMS hash matches {rel}")
    if not FAILURES:
        ok("all SHA256SUMS hashes match")


def validate_production_compose() -> None:
    """The deployed compose file (infra/docker) must carry no usable credential and stay loopback-bound."""
    path = ROOT / "infra/docker/docker-compose.prod.yml"
    if not path.exists():
        warn("infra/docker/docker-compose.prod.yml not present")
        return
    text = path.read_text(encoding="utf-8")
    compose = yaml.safe_load(text)
    require(not re.search(r"\$\{[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)[A-Z0-9_]*:-", text), "production compose declares no default value for any credential variable")
    require(not re.search(r"postgres(?:ql)?://[^\s:/@'\"]+:(?!\$\{)[^\s@'\"]{4,}@", text), "production compose embeds no database password")
    services = compose.get("services", {})
    for name in ("core", "worker"):
        require(".env.production" in (services.get(name, {}).get("env_file") or []), f"{name} reads credentials from .env.production")
    require(compose.get("networks", {}).get("core", {}).get("internal") is True, "production core network is internal")
    pg_ports = [str(p) for p in services.get("postgres", {}).get("ports", [])]
    require(all(p.startswith("127.0.0.1:") for p in pg_ports), "production PostgreSQL port is bound to loopback only")
    example = (ROOT / "infra/docker/.env.production.example").read_text(encoding="utf-8")
    documented = {line.split("=", 1)[0] for line in example.splitlines() if line and not line.startswith("#") and "=" in line}
    required = {"TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_ALLOWED_USERS", "TELEGRAM_INTAKE_ALLOWED_USERS",
                "HAWA_ADMIN_KEY", "HAWA_ART_DIRECTOR_KEY", "HAWA_BEARER_TOKEN", "HAWA_ACTION_HMAC_SECRET", "WAHA_WEBHOOK_SECRET",
                "CANVA_CLIENT_ID", "CANVA_CLIENT_SECRET", "CANVA_TOKEN_ENCRYPTION_KEY", "ANTHROPIC_API_KEY",
                "AUTO_GENERATE_CHAT_DESIGNS", "AUTO_GENERATE_DAILY_CAP_PER_SENDER", "AUTO_GENERATE_DAILY_CAP_GLOBAL"}
    missing = sorted(required - documented)
    require(not missing, "every security-relevant runtime variable is documented in .env.production.example" + (f"; missing={missing}" if missing else ""))
    require(not any("replace_with" not in line.lower() and any(k in line for k in ("SECRET=", "TOKEN=", "_KEY=")) and len(line.split("=", 1)[1]) > 24
                    for line in example.splitlines() if line and not line.startswith("#") and "=" in line),
            "the example env carries placeholders, never long credential-looking values")


def main() -> int:
    for fn in (
        validate_required_files,
        validate_requirements,
        validate_evaluations,
        validate_schemas_and_api,
        validate_sql,
        validate_contracts,
        validate_yaml_and_config,
        validate_production_compose,
        validate_markup_and_diagrams,
        validate_documents,
        validate_security_hygiene,
        validate_manifest,
    ):
        try:
            fn()
        except Exception as exc:
            fail(f"{fn.__name__} completed without exception: {type(exc).__name__}: {exc}")

    print(f"PASS={len(PASSES)} WARN={len(WARNINGS)} FAIL={len(FAILURES)}")
    for item in WARNINGS:
        print(f"WARN: {item}")
    for item in FAILURES:
        print(f"FAIL: {item}")
    if FAILURES:
        return 1
    print("Hawa Creative OS blueprint validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
