#!/usr/bin/env python3
"""Boot an authenticated paired Restate archive on a disposable offline volume (ADR-057).

This is a local archive-boot control, not the clean-host journal/effect replay gate.
The command never mounts the production volume, publishes ports, or pulls an image.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from restate_nightly import BackupError, inspect_tar, read_archive_metadata, sha256, verify_pair


IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
HASH = re.compile(r"^[0-9a-f]{64}$")
SOURCE_VOLUME = "hawa-production_restate_data"


class Runner:
    def run(self, args: list[str], *, timeout: int = 30, stdin: BinaryIO | None = None) -> str:
        try:
            result = subprocess.run(args, stdin=stdin, capture_output=True, text=True,
                                    check=False, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise BackupError(f"{args[0]} {args[1] if len(args) > 1 else ''} timed out") from exc
        if result.returncode:
            raise BackupError(f"{args[0]} {args[1] if len(args) > 1 else ''} failed: {result.stderr.strip()[-300:]}")
        return result.stdout.strip()


@dataclass(frozen=True)
class RestorePlan:
    pair: Path
    restate_manifest: Path
    encrypted_archive: Path
    node_name: str
    image_id: str
    compose_sha256: str
    ciphertext_sha256: str
    plaintext_sha256: str
    regular_files: int
    captured_at: str

    def receipt(self, status: str, invocation_count: int | None = None) -> dict:
        return {"status": status, "pair": self.pair.name,
                "restateManifest": self.restate_manifest.name, "nodeName": self.node_name,
                "imageId": self.image_id, "composeSha256": self.compose_sha256,
                "capturedAt": self.captured_at, "regularFiles": self.regular_files,
                "observedInvocations": invocation_count, "network": "none",
                "externalEffectReplayProved": False}


class Rehearsal:
    def __init__(self, pair: Path, key_file: Path, compose_file: Path,
                 runner: Runner | None = None, sleep=time.sleep, monotonic=time.monotonic):
        self.pair = pair
        self.key_file = key_file
        self.compose_file = compose_file
        self.runner = runner or Runner()
        self.sleep = sleep
        self.monotonic = monotonic

    def _locked_plan(self) -> tuple[RestorePlan, BinaryIO]:
        if not self.pair.is_file() or not self.key_file.is_file() or not self.compose_file.is_file():
            raise BackupError("explicit pair, archive key and matching Compose file are required")
        lock_path = self.pair.parent / ".restate-backup.lock"
        try:
            fd = os.open(lock_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except OSError as exc:
            raise BackupError("paired archive lock is missing or unreadable") from exc
        lock = os.fdopen(fd, "rb")
        try:
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            lock.close()
            raise BackupError("archive backup or retention is active; retry the rehearsal later") from exc
        try:
            pair_facts = verify_pair(self.pair, self.key_file)
            restate_manifest = self.pair.parent / pair_facts["restateManifestName"]
            facts = read_archive_metadata(restate_manifest, self.key_file)
            image_id = facts.get("restateImageId")
            compose_hash = facts.get("composeSha256")
            plaintext_hash = facts.get("plaintextSha256")
            regular_files = facts.get("regularFiles")
            if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
                raise BackupError("paired Restate image identity is invalid")
            if not isinstance(compose_hash, str) or not HASH.fullmatch(compose_hash):
                raise BackupError("paired Compose digest is invalid")
            if sha256(self.compose_file) != compose_hash:
                raise BackupError("supplied Compose file differs from the archived source configuration")
            if facts.get("volume") != SOURCE_VOLUME:
                raise BackupError("paired archive is not the selected single-node Restate volume")
            if not isinstance(plaintext_hash, str) or not HASH.fullmatch(plaintext_hash):
                raise BackupError("paired Restate plaintext digest is invalid")
            if type(regular_files) is not int or regular_files < 1:
                raise BackupError("paired Restate regular-file count is invalid")
            actual_id = self.runner.run(["docker", "image", "inspect", "--format", "{{.Id}}", image_id])
            if actual_id != image_id:
                raise BackupError("locally available Restate image differs from the archived image ID")
            plan = RestorePlan(self.pair, restate_manifest, restate_manifest.with_suffix(".tar.enc"),
                               facts["nodeName"], image_id, compose_hash,
                               facts["encryptedSha256"], plaintext_hash, regular_files,
                               facts["capturedAt"])
            return plan, lock
        except BaseException:
            lock.close()
            raise

    def plan(self) -> RestorePlan:
        plan, lock = self._locked_plan()
        lock.close()
        return plan

    def _decrypt(self, encrypted: Path, plain: Path, plan: RestorePlan) -> None:
        self.runner.run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "100000",
                         "-in", str(encrypted), "-out", str(plain), "-pass", f"file:{self.key_file}"],
                        timeout=3600)
        if sha256(plain) != plan.plaintext_sha256:
            raise BackupError("copied Restate archive did not decrypt to its recorded plaintext hash")
        if inspect_tar(plain, plan.node_name) != plan.regular_files:
            raise BackupError("copied Restate archive file count differs from its manifest")

    def _query_invocations(self, container: str) -> int:
        raw = self.runner.run(["docker", "exec", container, "curl", "-fsS", "--max-time", "5",
                               "-H", "content-type: application/json", "-H", "accept: application/json",
                               "-X", "POST", "--data", '{"query":"SELECT count(*) AS n FROM sys_invocation"}',
                               "http://127.0.0.1:9070/query"], timeout=10)
        try:
            rows = json.loads(raw)["rows"]
            count = rows[0]["n"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise BackupError("restored Restate SQL did not report invocation count") from exc
        if type(count) is not int or count < 0:
            raise BackupError("restored Restate invocation count is invalid")
        return count

    def _cleanup(self, label: str, volume: str) -> None:
        # A timed-out Docker CLI can still have created its resource. Query the private label,
        # including the extractor, rather than trusting which CLI calls returned successfully.
        errors: list[str] = []
        try:
            ids = self.runner.run(["docker", "ps", "-aq", "--filter", f"label={label}"]).splitlines()
            for container_id in ids:
                try:
                    self.runner.run(["docker", "rm", "-f", container_id])
                except Exception as exc:
                    errors.append(f"container {container_id}: {exc}")
        except Exception as exc:
            errors.append(f"containers labeled {label}: {exc}")
        try:
            volumes = self.runner.run(["docker", "volume", "ls", "-q", "--filter", f"label={label}"]).splitlines()
            if volume in volumes:
                self.runner.run(["docker", "volume", "rm", volume])
        except Exception as exc:
            errors.append(f"volume {volume}: {exc}")
        if errors:
            raise BackupError("disposable restore cleanup failed: " + "; ".join(errors))

    def apply(self) -> tuple[RestorePlan, int]:
        # Copy while retention's exclusive lock is excluded, then use only private temporary bytes.
        with tempfile.TemporaryDirectory(prefix="hawa-restate-restore-rehearsal-") as work:
            private = Path(work)
            plan, lock = self._locked_plan()
            copied = private / "restate.tar.enc"
            try:
                shutil.copyfile(plan.encrypted_archive, copied)
                if sha256(copied) != plan.ciphertext_sha256:
                    raise BackupError("paired Restate ciphertext changed while copying for rehearsal")
            finally:
                lock.close()
            plain = private / "restate.tar"
            self._decrypt(copied, plain, plan)

            nonce = uuid.uuid4().hex[:16]
            volume = f"hawa-r10-restore-{nonce}"
            container = f"hawa-r10-restore-{nonce}"
            label = f"hawa.restore-rehearsal={nonce}"
            count: int | None = None
            try:
                self.runner.run(["docker", "volume", "create", "--label", label, volume])
                with plain.open("rb") as source:
                    self.runner.run(["docker", "run", "-i", "--rm", "--pull=never", "--network", "none",
                                     "--name", f"{container}-extract", "--label", label,
                                     "--read-only", "--mount", f"type=volume,source={volume},target=/restate-data",
                                     "--entrypoint", "tar", plan.image_id,
                                     "-C", "/restate-data", "-xf", "-"], stdin=source, timeout=3600)
                self.runner.run(["docker", "run", "-d", "--pull=never", "--network", "none",
                                 "--name", container, "--label", label,
                                 "--mount", f"type=volume,source={volume},target=/restate-data",
                                 "-e", f"RESTATE_NODE_NAME={plan.node_name}", plan.image_id])
                deadline = self.monotonic() + 90
                while True:
                    try:
                        count = self._query_invocations(container)
                        break
                    except BackupError:
                        if self.monotonic() >= deadline:
                            raise BackupError("restored Restate SQL did not become ready within 90 seconds")
                        self.sleep(min(2, max(0, deadline - self.monotonic())))
            finally:
                self._cleanup(label, volume)
            if count is None:
                raise BackupError("restored Restate SQL did not return a count")
            return plan, count


def main() -> int:
    os.umask(0o077)
    def interrupted(_signum, _frame):
        raise InterruptedError("restore rehearsal interrupted; temporary-resource cleanup attempted")
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pair", type=Path, required=True, help="explicit authenticated nightly pair")
    parser.add_argument("--key-file", type=Path, required=True, help="archive passphrase file")
    parser.add_argument("--compose-file", type=Path, required=True, help="matching source Compose file")
    parser.add_argument("--apply", action="store_true", help="boot a disposable offline restored node")
    args = parser.parse_args()
    try:
        rehearsal = Rehearsal(args.pair, args.key_file, args.compose_file)
        if args.apply:
            plan, count = rehearsal.apply()
            print(json.dumps(plan.receipt("isolated_boot_verified", count)))
        else:
            print(json.dumps(rehearsal.plan().receipt("ready_for_isolated_boot")))
        return 0
    except (BackupError, OSError) as exc:
        print(f"Restate restore rehearsal refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
