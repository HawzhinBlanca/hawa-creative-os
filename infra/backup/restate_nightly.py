#!/usr/bin/env python3
"""Guarded cold copy of Hawa's single-node Restate volume (ADR-053).

The default --plan only checks prerequisites. --apply pauses Telegram intake, stops Restate,
archives its complete volume, verifies an encrypted copy, restarts Restate and then publishes the
archive manifest. This is deliberately separate from the PostgreSQL/blob backup: their clocks are
not an atomic distributed snapshot. Never restore the archive into a running or shared node.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Callable
from archive_lock import inherited_lock


ROOT = Path(__file__).resolve().parents[2]
PINNED_IMAGE = re.compile(r"^\S+@sha256:[0-9a-f]{64}$")
STAMP = re.compile(r"^[0-9]{8}T[0-9]{6}Z$")


class BackupError(RuntimeError):
    pass


@dataclass(frozen=True)
class Config:
    compose_file: Path
    compose_env: Path
    archive_dir: Path
    key_file: Path
    helper_image: str
    volume: str = "hawa-production_restate_data"
    container: str = "hawa-production-restate-1"
    core_container: str = "hawa-production-core-1"
    postgres_container: str = "hawa-production-postgres-1"
    node_name: str = "hawa-restate-prod-1"
    drain_seconds: int = 300
    health_seconds: int = 90


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def metadata_mac(facts: dict, key_file: Path, purpose: bytes) -> str:
    """Authenticate archive metadata with a purpose-separated key from the office passphrase."""
    passphrase = key_file.read_bytes().splitlines()
    if not passphrase or not passphrase[0]:
        raise BackupError("Restate archive key file is empty")
    key = hashlib.pbkdf2_hmac("sha256", passphrase[0], purpose, 100_000)
    message = json.dumps(facts, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(key, message, hashlib.sha256).hexdigest()


def manifest_mac(facts: dict, key_file: Path) -> str:
    return metadata_mac(facts, key_file, b"hawa/restate/manifest-v2")


def pair_mac(facts: dict, key_file: Path) -> str:
    return metadata_mac(facts, key_file, b"hawa/restate/nightly-pair-v1")


def pair_inputs(archive_dir: Path, stamp: str) -> dict:
    """Validate the same-night database/file half before pausing live Restate intake."""
    if not STAMP.fullmatch(stamp):
        raise BackupError("nightly snapshot stamp is invalid")
    dump = archive_dir / f"hawa_{stamp}.dump.enc"
    blob_manifest = archive_dir / f"hawa_{stamp}.blobs"
    sidecar = archive_dir / f"hawa_{stamp}.dump.enc.sha256"
    if not dump.is_file() or not blob_manifest.is_file() or not sidecar.is_file():
        raise BackupError("same-night encrypted dump, blob manifest or checksum is missing")
    dump_hash = sha256(dump)
    recorded_hash = sidecar.read_text().split()
    if len(recorded_hash) != 1 or recorded_hash[0] != dump_hash:
        raise BackupError("same-night encrypted dump checksum differs from its sidecar")
    return {"dumpName": dump.name, "dumpSha256": dump_hash,
            "blobManifestName": blob_manifest.name, "blobManifestSha256": sha256(blob_manifest)}


def publish_pair(archive_dir: Path, stamp: str, inputs: dict, restate_manifest: Path, key_file: Path) -> Path:
    name = f"hawa_{stamp}.restate.json"
    final = archive_dir / name
    part = archive_dir / f"{name}.part"
    if final.exists() or part.exists():
        raise BackupError("a same-night Restate pair already exists")
    restate = json.loads(restate_manifest.read_text())
    facts = {"schemaVersion": 1, "snapshotStamp": stamp, **inputs,
             "restateManifestName": restate_manifest.name,
             "restateManifestSha256": sha256(restate_manifest),
             "restateCapturedAt": restate["capturedAt"], "crossStoreAtomic": False}
    facts["pairMac"] = pair_mac(facts, key_file)
    try:
        part.write_text(json.dumps(facts, indent=2) + "\n")
        os.chmod(part, 0o600)
        os.replace(part, final)
    finally:
        part.unlink(missing_ok=True)
    return final


def read_pair_metadata(pair: Path, key_file: Path) -> dict:
    """Authenticate a pair and validate its names without reading large archived bytes."""
    match = re.fullmatch(r"hawa_([0-9]{8}T[0-9]{6}Z)\.restate\.json", pair.name)
    if not match:
        raise BackupError("not a same-night Restate pair name")
    try:
        facts = json.loads(pair.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise BackupError("same-night Restate pair is unreadable") from exc
    if not isinstance(facts, dict) or facts.get("schemaVersion") != 1 or facts.get("snapshotStamp") != match.group(1):
        raise BackupError("same-night Restate pair version or stamp is invalid")
    if not key_file.is_file():
        raise BackupError("same-night Restate pair key is missing")
    declared = facts.get("pairMac")
    authenticated = {key: value for key, value in facts.items() if key != "pairMac"}
    if not isinstance(declared, str) or not hmac.compare_digest(declared, pair_mac(authenticated, key_file)):
        raise BackupError("same-night Restate pair authentication failed")
    stamp = match.group(1)
    if facts.get("dumpName") != f"hawa_{stamp}.dump.enc" or facts.get("blobManifestName") != f"hawa_{stamp}.blobs":
        raise BackupError("same-night Restate pair names do not match its dump stamp")
    restate_name = facts.get("restateManifestName")
    if not isinstance(restate_name, str) or not re.fullmatch(r"restate_[0-9]{8}T[0-9]{6}Z\.json", restate_name):
        raise BackupError("same-night Restate manifest name is invalid")
    for name_field, hash_field in (("dumpName", "dumpSha256"), ("blobManifestName", "blobManifestSha256"),
                                   ("restateManifestName", "restateManifestSha256")):
        recorded_hash = facts.get(hash_field)
        if not isinstance(recorded_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", recorded_hash):
            raise BackupError(f"same-night archive hash is invalid: {hash_field}")
    if not isinstance(facts.get("restateCapturedAt"), str) or facts.get("crossStoreAtomic") is not False:
        raise BackupError("same-night Restate pair capture metadata is invalid")
    return facts


def verify_pair(pair: Path, key_file: Path) -> dict:
    """Verify the exact archived dump, blob manifest and Restate volume selected as one night."""
    facts = read_pair_metadata(pair, key_file)
    restate_name = facts["restateManifestName"]
    for name_field, hash_field in (("dumpName", "dumpSha256"), ("blobManifestName", "blobManifestSha256"),
                                   ("restateManifestName", "restateManifestSha256")):
        recorded_hash = facts[hash_field]
        path = pair.parent / facts[name_field]
        if not path.is_file() or sha256(path) != recorded_hash:
            raise BackupError(f"same-night archive differs from pair: {name_field}")
    restate = verify_archive(pair.parent / restate_name, key_file)
    if restate["capturedAt"] != facts.get("restateCapturedAt") or facts.get("crossStoreAtomic") is not False:
        raise BackupError("same-night Restate capture metadata differs from pair")
    return facts


def inspect_tar(path: Path, node_name: str) -> int:
    """Check a full-volume copy, including safe files outside the named node directory."""
    files = 0
    node_files = 0
    names: set[str] = set()
    try:
        with tarfile.open(path, "r:") as archive:
            for item in archive:
                name = item.name.removeprefix("./")
                if name in ("", ".") and item.isdir():
                    continue
                parts = PurePosixPath(name).parts
                if not parts or ".." in parts or name.startswith("/"):
                    raise BackupError("Restate archive contains an unsafe path")
                if item.issym() or item.islnk() or item.isdev():
                    raise BackupError("Restate archive contains an unsafe link or device")
                normalized = str(PurePosixPath(name))
                if normalized in names or not (item.isfile() or item.isdir()):
                    raise BackupError("Restate archive contains duplicate or unsupported members")
                names.add(normalized)
                if item.isfile():
                    files += 1
                    if parts[0] == node_name:
                        node_files += 1
    except (tarfile.TarError, EOFError) as exc:
        raise BackupError(f"Restate archive cannot be read: {exc}") from exc
    if node_files == 0:
        raise BackupError("Restate archive has no data files under its expected node name")
    return files


def read_archive_metadata(manifest: Path, key_file: Path) -> dict:
    """Authenticate archive facts and ciphertext hash without decrypting the volume."""
    if not re.fullmatch(r"restate_[0-9]{8}T[0-9]{6}Z\.json", manifest.name):
        raise BackupError("not a Restate backup manifest name")
    try:
        facts = json.loads(manifest.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise BackupError("Restate backup manifest is unreadable") from exc
    if not isinstance(facts, dict) or facts.get("schemaVersion") != 2 or facts.get("encrypted") is not True:
        raise BackupError("Restate backup manifest version or encryption is invalid")
    if not key_file.is_file():
        raise BackupError("Restate archive decryption key is missing")
    declared_mac = facts.get("manifestMac")
    authenticated = {key: value for key, value in facts.items() if key != "manifestMac"}
    if not isinstance(declared_mac, str) or not hmac.compare_digest(declared_mac, manifest_mac(authenticated, key_file)):
        raise BackupError("Restate backup manifest authentication failed")
    node = facts.get("nodeName")
    if not isinstance(node, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", node):
        raise BackupError("Restate backup node name is invalid")
    archive = manifest.with_suffix(".tar.enc")
    if not archive.is_file() or not key_file.is_file():
        raise BackupError("Restate archive or decryption key is missing")
    if sha256(archive) != facts.get("encryptedSha256"):
        raise BackupError("encrypted Restate archive hash differs from manifest")
    return facts


def verify_archive(manifest: Path, key_file: Path) -> dict:
    """Independent later read of the stored ciphertext; still not a running-node restore drill."""
    facts = read_archive_metadata(manifest, key_file)
    archive = manifest.with_suffix(".tar.enc")
    node = facts["nodeName"]
    with tempfile.TemporaryDirectory(prefix="hawa-restate-verify-") as work:
        plain = Path(work) / "restate.tar"
        try:
            result = subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "100000",
                                     "-in", str(archive), "-out", str(plain), "-pass", f"file:{key_file}"],
                                    capture_output=True, check=False, timeout=3600)
        except subprocess.TimeoutExpired as exc:
            raise BackupError("stored Restate archive decryption timed out") from exc
        if result.returncode:
            raise BackupError("stored Restate archive cannot be decrypted")
        if sha256(plain) != facts.get("plaintextSha256"):
            raise BackupError("decrypted Restate archive hash differs from manifest")
        files = inspect_tar(plain, node)
    if files != facts.get("regularFiles"):
        raise BackupError("Restate archive file count differs from manifest")
    return facts


class Runner:
    def run(self, args: list[str]) -> str:
        try:
            result = subprocess.run(args, capture_output=True, text=True, check=False, timeout=3600)
        except subprocess.TimeoutExpired as exc:
            raise BackupError(f"{args[0]} timed out") from exc
        if result.returncode:
            raise BackupError(f"{args[0]} {args[1] if len(args) > 1 else ''} failed: {result.stderr.strip()[:300]}")
        return result.stdout.strip()

    def archive(self, args: list[str], path: Path) -> None:
        with path.open("wb") as output:
            try:
                result = subprocess.run(args, stdout=output, stderr=subprocess.PIPE, check=False, timeout=3600)
            except subprocess.TimeoutExpired as exc:
                raise BackupError("volume archive timed out") from exc
        if result.returncode:
            raise BackupError(f"volume archive failed: {result.stderr.decode(errors='replace')[:300]}")


CORE_CONTROL = r"""
const action = process.argv[1];
const expectedChangeTag = process.argv[2];
const token = process.env.HAWA_ART_DIRECTOR_KEY || process.env.HAWA_BEARER_TOKEN;
if (!token) throw new Error('Core has no operator credential for the backup switch');
const base = 'http://127.0.0.1:3001/v1';
const url = action === 'status' ? '/ingress/status' : '/ingress/channels/telegram/toggle';
const payload = {enabled:action==='release', ...(expectedChangeTag ? {expectedChangeTag} : {})};
const init = action === 'status' ? {} : {method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(payload)};
const response = await fetch(base + url, {...init,signal:AbortSignal.timeout(5000)});
if (!response.ok) throw new Error('Core switch API answered HTTP ' + response.status);
const result = await response.json();
console.log(JSON.stringify(result));
"""

RESTATE_RUNNING = r"""
const response = await fetch('http://restate:9070/query',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({query:"SELECT count(*) AS n FROM sys_invocation WHERE status = 'running'"}),signal:AbortSignal.timeout(5000)});
if (!response.ok) throw new Error('Restate query answered HTTP '+response.status);
const rows = (await response.json()).rows;
const n = Number(rows?.[0]?.n);
if (!Number.isSafeInteger(n) || n < 0) throw new Error('Restate running count is missing');
console.log(n);
"""

PERSISTED_TELEGRAM_SWITCH = """SELECT CASE WHEN EXISTS (
  SELECT 1 FROM hawa.integrations i
  JOIN hawa.integration_health h ON h.integration_id = i.id
  WHERE i.tenant_id = '00000000-0000-4000-a000-000000000001'::uuid
    AND i.kind = 'telegram' AND i.name = 'office-kill-switch' AND h.state = 'disabled'
) THEN 'f' ELSE 't' END"""


class RestateBackup:
    def __init__(self, config: Config, runner: Runner | None = None, sleep: Callable[[float], None] = time.sleep):
        self.c = config
        self.r = runner or Runner()
        self.sleep = sleep

    def compose(self, *args: str) -> str:
        return self.r.run(["docker", "compose", "-f", str(self.c.compose_file), "--env-file", str(self.c.compose_env), *args])

    def core(self, action: str, expected_change_tag: str | None = None) -> dict:
        args = ["docker", "exec", self.c.core_container, "node", "-e", CORE_CONTROL, action]
        if expected_change_tag:
            args.append(expected_change_tag)
        raw = self.r.run(args)
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise BackupError("Core switch API returned malformed JSON") from exc
        if not isinstance(value, dict):
            raise BackupError("Core switch API returned no object")
        return value

    def telegram_enabled(self) -> bool:
        value = self.core("status").get("channels", {}).get("telegram")
        if not isinstance(value, bool):
            raise BackupError("Core did not report the persisted Telegram switch")
        persisted = self.r.run(["docker", "exec", self.c.postgres_container, "psql", "-U", "hawa_owner",
                                "-d", "hawa", "-At", "-v", "ON_ERROR_STOP=1", "-c", PERSISTED_TELEGRAM_SWITCH])
        if persisted not in ("t", "f") or value is not (persisted == "t"):
            raise BackupError("Core and PostgreSQL disagree about the Telegram intake switch")
        return value

    def set_telegram(self, enabled: bool, expected_change_tag: str | None = None) -> str:
        if enabled and not expected_change_tag:
            raise BackupError("Restate backup cannot release intake without its pause revision")
        answer = self.core("release" if enabled else "pause", expected_change_tag)
        if answer.get("enabled") is not enabled or answer.get("killSwitchActive") is not (not enabled):
            raise BackupError("Core did not confirm the persisted Telegram switch")
        change_tag = answer.get("changeTag")
        if not isinstance(change_tag, str) or not re.fullmatch(r"[0-9a-f-]{36}", change_tag):
            raise BackupError("Core did not return the persisted switch revision")
        if self.telegram_enabled() is not enabled:
            raise BackupError("Telegram switch readback did not match the requested state")
        return change_tag

    def preflight(self) -> dict:
        c = self.c
        if not PINNED_IMAGE.fullmatch(c.helper_image):
            raise BackupError("HAWA_RESTATE_BACKUP_HELPER_IMAGE must be an immutable @sha256 digest")
        if not c.compose_file.is_file() or not c.compose_env.is_file():
            raise BackupError("production Compose file and interpolation environment are required")
        if not c.key_file.is_file() or not os.access(c.key_file, os.R_OK):
            raise BackupError("HAWA_BACKUP_ARCHIVE_KEYFILE must name a readable encryption key")
        manifest_mac({}, c.key_file)  # refuse an empty passphrase before touching intake
        self.r.run(["docker", "image", "inspect", c.helper_image])  # --pull=never below
        self.r.run(["docker", "volume", "inspect", c.volume])
        image_id = self.r.run(["docker", "inspect", "--format", "{{.Image}}", c.container])
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
            raise BackupError("Restate container has no immutable image ID")
        if self.r.run(["docker", "inspect", "--format", "{{.State.Running}}", c.container]) != "true":
            raise BackupError("Restate is not running")
        return {"restateImageId": image_id, "composeSha256": sha256(c.compose_file),
                "telegramEnabled": self.telegram_enabled()}

    def running_invocations(self) -> int:
        raw = self.r.run(["docker", "exec", self.c.core_container, "node", "-e", RESTATE_RUNNING])
        try:
            value = int(raw)
        except ValueError as exc:
            raise BackupError("Restate did not report a running invocation count") from exc
        if value < 0:
            raise BackupError("Restate reported a negative running invocation count")
        return value

    def drain(self) -> int:
        deadline = time.monotonic() + self.c.drain_seconds
        while True:
            n = self.running_invocations()
            if n == 0 or time.monotonic() >= deadline:
                return n
            self.sleep(min(2, max(0, deadline - time.monotonic())))

    def wait_healthy(self) -> None:
        deadline = time.monotonic() + self.c.health_seconds
        while True:
            status = self.r.run(["docker", "inspect", "--format", "{{.State.Health.Status}}", self.c.container])
            if status == "healthy":
                return
            if time.monotonic() >= deadline:
                raise BackupError(f"Restate did not become healthy after restart (last status: {status})")
            self.sleep(min(2, max(0, deadline - time.monotonic())))

    def encrypt_and_verify(self, plain: Path, encrypted: Path) -> str:
        args = ["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "100000", "-salt",
                "-in", str(plain), "-out", str(encrypted), "-pass", f"file:{self.c.key_file}"]
        self.r.run(args)
        verify = subprocess.Popen(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "100000",
                                   "-in", str(encrypted), "-pass", f"file:{self.c.key_file}"],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        digest = hashlib.sha256()
        assert verify.stdout is not None
        for block in iter(lambda: verify.stdout.read(1024 * 1024), b""):
            digest.update(block)
        stderr = verify.stderr.read().decode(errors="replace") if verify.stderr else ""
        verify.stdout.close()
        if verify.stderr:
            verify.stderr.close()
        if verify.wait() or digest.hexdigest() != sha256(plain):
            raise BackupError(f"encrypted Restate archive did not round-trip: {stderr[:200]}")
        return digest.hexdigest()

    def apply(self, pair_stamp: str | None = None) -> Path:
        c = self.c
        if not c.archive_dir.is_dir():
            raise BackupError("archive destination must already exist; no implicit off-host location")
        if inherited_lock(c.archive_dir, 'exclusive'):
            return self._apply_locked(pair_stamp)
        lock_path = c.archive_dir / ".restate-backup.lock"
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise BackupError("another Restate volume backup owns the archive lock") from exc
            return self._apply_locked(pair_stamp)

    def _apply_locked(self, pair_stamp: str | None = None) -> Path:
        pair = pair_inputs(self.c.archive_dir, pair_stamp) if pair_stamp is not None else None
        if pair_stamp is not None and any((self.c.archive_dir / f"hawa_{pair_stamp}.restate.json{suffix}").exists()
                                          for suffix in ("", ".part")):
            raise BackupError("a same-night Restate pair already exists")
        facts = self.preflight()
        c = self.c
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        name = f"restate_{stamp}"
        final = c.archive_dir / f"{name}.tar.enc"
        manifest = c.archive_dir / f"{name}.json"
        part = c.archive_dir / f"{name}.tar.enc.part"
        manifest_part = c.archive_dir / f"{name}.json.part"
        if any(p.exists() for p in (final, manifest, part, manifest_part)):
            raise BackupError("a Restate backup with this timestamp already exists")
        was_enabled = facts["telegramEnabled"]
        paused_by_us = False
        pause_change_tag: str | None = None
        stopped = False
        recovered = False
        published = False
        try:
            if was_enabled:
                pause_change_tag = self.set_telegram(False)
                paused_by_us = True
            running_at_stop = self.drain()
            stopped = True
            self.compose("stop", "restate")
            captured_at = datetime.now(timezone.utc).isoformat()
            with tempfile.TemporaryDirectory(prefix="hawa-restate-backup-") as work:
                plain = Path(work) / "restate.tar"
                self.r.archive(["docker", "run", "--rm", "--pull=never",
                                "--mount", f"type=volume,source={c.volume},target=/restate-data,readonly",
                                "--entrypoint", "tar", c.helper_image,
                                "-C", "/restate-data", "-cf", "-", "."], plain)
                count = inspect_tar(plain, c.node_name)
                plain_hash = self.encrypt_and_verify(plain, part)
                os.chmod(part, 0o600)
                encrypted_hash = sha256(part)
                archive_bytes = part.stat().st_size
            self.compose("up", "-d", "--no-deps", "restate")
            self.wait_healthy()
            stopped = False
            recovered = True
            if paused_by_us:
                self.set_telegram(True, pause_change_tag)
                paused_by_us = False
            metadata = {"schemaVersion": 2, "capturedAt": captured_at,
                        "serviceRecoveredAt": datetime.now(timezone.utc).isoformat(),
                        "nodeName": c.node_name, "volume": c.volume, "restateImageId": facts["restateImageId"],
                        "composeSha256": facts["composeSha256"], "encryptedSha256": encrypted_hash,
                        "plaintextSha256": plain_hash, "encryptedBytes": archive_bytes, "regularFiles": count,
                        "runningInvocationsAtStop": running_at_stop, "encrypted": True,
                        "crossStoreAtomic": False}
            metadata["manifestMac"] = manifest_mac(metadata, c.key_file)
            manifest_part.write_text(json.dumps(metadata, indent=2) + "\n")
            os.chmod(manifest_part, 0o600)
            os.replace(part, final)
            os.replace(manifest_part, manifest)
            published = True
            if pair is not None:
                try:
                    current_pair = pair_inputs(c.archive_dir, pair_stamp)
                except BackupError as exc:
                    raise BackupError("same-night database or blob input changed during Restate capture") from exc
                if current_pair != pair:
                    raise BackupError("same-night database or blob input changed during Restate capture")
                publish_pair(c.archive_dir, pair_stamp, pair, manifest, c.key_file)
            return manifest
        finally:
            # A failed restart leaves intake paused; the operator must recover Restate first.
            if stopped:
                try:
                    self.compose("up", "-d", "--no-deps", "restate")
                    self.wait_healthy()
                    recovered = True
                except Exception as exc:  # preserve the first failure, but surface the unsafe state
                    print(f"CRITICAL: Restate restart failed; Telegram intake remains paused: {exc}", file=sys.stderr)
            if paused_by_us and recovered:
                try:
                    self.set_telegram(True, pause_change_tag)
                except Exception as exc:
                    print(f"CRITICAL: Restate is healthy but Telegram intake remains paused: {exc}", file=sys.stderr)
            for path in (part, manifest_part):
                path.unlink(missing_ok=True)
            if not published:
                final.unlink(missing_ok=True)


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--apply", action="store_true", help="pause intake and cold-copy the production Restate volume")
    action.add_argument("--verify-archive", type=Path, help="re-read and decrypt a stored archive without contacting production")
    action.add_argument("--verify-pair", type=Path, help="verify the exact database, blobs and Restate archives paired to one night")
    parser.add_argument("--pair-stamp", help="bind --apply to the same-night database dump and blob manifest")
    args = parser.parse_args()
    if args.pair_stamp and not args.apply:
        parser.error("--pair-stamp requires --apply")
    config = Config(compose_file=ROOT / "infra/docker/docker-compose.prod.yml",
                    compose_env=ROOT / "infra/docker/.env",
                    archive_dir=Path(os.environ.get("HAWA_BACKUP_ARCHIVE_DEST", str(Path.home() / ".hawa/snapshots_archive"))),
                    key_file=Path(os.environ.get("HAWA_BACKUP_ARCHIVE_KEYFILE", "")),
                    helper_image=os.environ.get("HAWA_RESTATE_BACKUP_HELPER_IMAGE", ""))
    backup = RestateBackup(config)
    try:
        if args.verify_pair:
            facts = verify_pair(args.verify_pair, config.key_file)
            print(json.dumps({"status": "verified_pair", "dumpName": facts["dumpName"],
                              "restateManifestName": facts["restateManifestName"]}))
        elif args.verify_archive:
            facts = verify_archive(args.verify_archive, config.key_file)
            print(json.dumps({"status": "verified_archive", "regularFiles": facts["regularFiles"],
                              "nodeName": facts["nodeName"], "capturedAt": facts["capturedAt"]}))
        elif args.apply:
            print(f"Restate backup published: {backup.apply(args.pair_stamp)}")
        else:
            print(json.dumps({"status": "ready", "target": "single-node Restate", **backup.preflight()}))
        return 0
    except (BackupError, OSError) as exc:
        print(f"Restate backup refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
