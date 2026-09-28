"""Authenticated archive and cleanup controls; Docker is simulated, encryption is real."""
from __future__ import annotations

import fcntl
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from typing import BinaryIO

from restate_nightly import BackupError, manifest_mac, pair_inputs, publish_pair, sha256
from restate_restore_rehearsal import Rehearsal, Runner


IMAGE = "sha256:" + "b" * 64
NODE = "hawa-restate-prod-1"


def write_pair(root: Path, compose: Path, key: Path, plain: Path,
               image: str = IMAGE, file_count: int = 1) -> Path:
    """Build the real signed/encrypted wire format from synthetic local fixture bytes."""
    stamp = "20260926T000000Z"
    manifest = root / f"restate_{stamp}.json"
    encrypted = manifest.with_suffix(".tar.enc")
    subprocess.run(["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "100000",
                    "-in", str(plain), "-out", str(encrypted), "-pass", f"file:{key}"],
                   check=True, capture_output=True)
    facts = {"schemaVersion": 2, "encrypted": True, "nodeName": NODE,
             "volume": "hawa-production_restate_data", "restateImageId": image,
             "composeSha256": sha256(compose), "capturedAt": "2026-09-26T00:00:00Z",
             "plaintextSha256": sha256(plain), "encryptedSha256": sha256(encrypted),
             "regularFiles": file_count}
    facts["manifestMac"] = manifest_mac(facts, key)
    manifest.write_text(json.dumps(facts))
    dump = root / f"hawa_{stamp}.dump.enc"
    dump.write_bytes(b"synthetic database half; no production records")
    (root / f"hawa_{stamp}.dump.enc.sha256").write_text(sha256(dump))
    (root / f"hawa_{stamp}.blobs").write_text("")
    (root / ".restate-backup.lock").touch()
    pair = root / f"hawa_{stamp}.restate.json"
    pair.unlink(missing_ok=True)
    return publish_pair(root, stamp, pair_inputs(root, stamp), manifest, key)


class FakeDocker(Runner):
    def __init__(self, failure: str = "", query: str = '{"rows":[{"n":7}]}'):
        self.failure, self.query = failure, query
        self.calls: list[list[str]] = []
        self.containers: set[str] = set()
        self.volume: str | None = None
        self.now = 0

    def sleep(self, seconds: float) -> None:
        self.now += seconds

    def run(self, args: list[str], *, timeout: int = 30, stdin: BinaryIO | None = None) -> str:
        if args[0] == "openssl":
            return super().run(args, timeout=timeout, stdin=stdin)
        self.calls.append(args)
        if args[:3] == ["docker", "image", "inspect"]:
            return "sha256:" + "a" * 64 if self.failure == "image" else IMAGE
        if args[:3] == ["docker", "volume", "create"]:
            self.volume = args[-1]
            if self.failure == "volume":
                raise BackupError("synthetic volume CLI timeout after creation")
            return self.volume
        if args[:2] == ["docker", "run"]:
            name = args[args.index("--name") + 1]
            self.containers.add(name)
            if "--entrypoint" in args:
                assert stdin is not None
                with tarfile.open(fileobj=stdin, mode="r:") as archive:
                    assert len(archive.getmembers()) >= 1
                if self.failure == "extract":
                    raise BackupError("synthetic extractor timeout after creation")
                self.containers.remove(name)  # --rm on successful extractor
            elif self.failure == "start":
                raise BackupError("synthetic server CLI timeout after creation")
            elif self.failure == "interrupt":
                raise KeyboardInterrupt()
            return name
        if args[:2] == ["docker", "exec"]:
            if self.failure == "query":
                raise BackupError("synthetic SQL unavailable")
            return self.query
        if args[:3] == ["docker", "ps", "-aq"]:
            return "\n".join(sorted(self.containers))
        if args[:3] == ["docker", "rm", "-f"]:
            self.containers.remove(args[-1])
            return args[-1]
        if args[:3] == ["docker", "volume", "ls"]:
            return self.volume or ""
        if args[:3] == ["docker", "volume", "rm"]:
            if self.failure == "cleanup":
                raise BackupError("synthetic Docker cleanup failure")
            self.volume = None
            return args[-1]
        raise AssertionError(args)


class FakeVolumeDocker(Runner):
    """A named volume held in memory: listing, extraction and the guards restore_into asks about."""

    def __init__(self, *, mounted: bool = False, running_node: str | None = None, preexisting: bool = False,
                 corrupt: bool = False):
        self.files: dict[str, bytes] = {"stale/file": b"old"} if preexisting else {}
        self.mounted, self.running_node, self.corrupt = mounted, running_node, corrupt
        self.calls: list[list[str]] = []
        self.helpers: set[str] = set()

    def run(self, args: list[str], *, timeout: int = 30, stdin: BinaryIO | None = None) -> str:
        if args[0] == "openssl":
            return super().run(args, timeout=timeout, stdin=stdin)
        self.calls.append(args)
        if args[:3] == ["docker", "image", "inspect"]:
            return IMAGE
        if args[:3] == ["docker", "volume", "inspect"]:
            return "[]"
        if args[:3] == ["docker", "ps", "-aq"] and args[4].startswith("volume="):
            return "c0ffee" if self.mounted else ""
        if args[:3] == ["docker", "ps", "-q"]:
            return "abc123" if self.running_node else ""
        if args[:3] == ["docker", "inspect", "--format"]:
            return json.dumps([f"RESTATE_NODE_NAME={self.running_node}", "PATH=/bin"])
        if args[:3] == ["docker", "ps", "-aq"]:
            return "\n".join(sorted(self.helpers))
        if args[:3] == ["docker", "rm", "-f"]:
            self.helpers.discard(args[-1])
            return args[-1]
        if args[:2] == ["docker", "run"] and "-xpf" in args:
            assert stdin is not None and "--network" in args and args[args.index("--network") + 1] == "none"
            with tarfile.open(fileobj=stdin, mode="r:") as archive:
                for item in archive:
                    if item.isfile():
                        stream = archive.extractfile(item)
                        assert stream is not None
                        self.files[item.name.removeprefix("./")] = stream.read()
            if self.corrupt:
                self.files[f"{NODE}/journal"] = b"changed"
            return ""
        raise AssertionError(args)

    def to_file(self, args: list[str], path: Path, *, timeout: int = 3600) -> None:
        self.calls.append(args)
        assert "readonly" in args[args.index("--mount") + 1]
        with tarfile.open(path, "w") as archive:
            root = tarfile.TarInfo(".")
            root.type = tarfile.DIRTYPE
            archive.addfile(root)
            for name, data in sorted(self.files.items()):
                item = tarfile.TarInfo(f"./{name}")
                item.size = len(data)
                archive.addfile(item, io.BytesIO(data))


class RestoreRehearsalTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.compose, self.key, self.plain = [self.root / name for name in ("compose.yml", "key", "archive.tar")]
        self.compose.write_text("synthetic source configuration")
        self.key.write_text("synthetic-test-passphrase\n")
        self.write_tar()
        self.pair = write_pair(self.root, self.compose, self.key, self.plain)

    def write_tar(self, extra: tarfile.TarInfo | None = None) -> None:
        with tarfile.open(self.plain, "w") as archive:
            item = tarfile.TarInfo(f"./{NODE}/journal")
            item.size = 7
            archive.addfile(item, io.BytesIO(b"journal"))
            if extra:
                archive.addfile(extra, io.BytesIO(b""))

    def rehearsal(self, fake: FakeDocker) -> Rehearsal:
        return Rehearsal(self.pair, self.key, self.compose, fake,
                         sleep=fake.sleep, monotonic=lambda: fake.now)

    def test_plan_authenticates_pair_and_only_inspects_local_image(self) -> None:
        fake = FakeDocker()
        receipt = self.rehearsal(fake).plan().receipt("ready_for_isolated_boot")
        self.assertEqual(receipt["imageId"], IMAGE)
        self.assertFalse(receipt["externalEffectReplayProved"])
        self.assertIsNone(receipt["observedInvocations"])
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(fake.calls[0][:3], ["docker", "image", "inspect"])

    def test_apply_uses_fresh_offline_volume_exact_image_and_json_then_cleans(self) -> None:
        fake = FakeDocker()
        plan, count = self.rehearsal(fake).apply()
        self.assertEqual(count, 7)
        self.assertFalse(plan.receipt("isolated_boot_verified", count)["externalEffectReplayProved"])
        runs = [call for call in fake.calls if call[:2] == ["docker", "run"]]
        self.assertEqual(len(runs), 2)
        for call in runs:
            self.assertIn(IMAGE, call)
            self.assertEqual(call[call.index("--network") + 1], "none")
            self.assertIn("--pull=never", call)
            mount = call[call.index("--mount") + 1]
            self.assertRegex(mount, r"^type=volume,source=hawa-r10-restore-[0-9a-f]{16},target=/restate-data$")
            self.assertNotIn("-p", call)
            self.assertNotIn("--publish", call)
        query = next(call for call in fake.calls if call[:2] == ["docker", "exec"])
        self.assertIn("accept: application/json", query)
        self.assertFalse(fake.containers)
        self.assertIsNone(fake.volume)

    def test_wrong_key_changed_pair_compose_and_image_refuse_before_creation(self) -> None:
        for defect in ("key", "pair", "compose", "image"):
            with self.subTest(defect=defect):
                path = {"key": self.key, "pair": self.pair, "compose": self.compose}.get(defect)
                original = path.read_bytes() if path else None
                if path:
                    path.write_bytes(b"changed")
                fake = FakeDocker(defect)
                try:
                    with self.assertRaises(BackupError):
                        self.rehearsal(fake).apply()
                    self.assertFalse(any(call[:2] == ["docker", "run"] for call in fake.calls))
                    self.assertIsNone(fake.volume)
                finally:
                    if path and original is not None:
                        path.write_bytes(original)

    def test_archive_lock_refuses_and_releases_without_docker(self) -> None:
        fake = FakeDocker()
        with (self.root / ".restate-backup.lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(BackupError, "retention is active"):
                self.rehearsal(fake).apply()
            self.assertEqual(fake.calls, [])
        self.rehearsal(fake).plan()
        with (self.root / ".restate-backup.lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_authenticated_unsafe_tar_is_refused_before_docker(self) -> None:
        for name, kind in ((f"./{NODE}/./journal", tarfile.REGTYPE),
                           ("../../outside", tarfile.REGTYPE),
                           (f"{NODE}/link", tarfile.SYMTYPE),
                           (f"{NODE}/pipe", tarfile.FIFOTYPE)):
            with self.subTest(name=name):
                item = tarfile.TarInfo(name)
                item.type = kind
                self.write_tar(item)
                self.pair = write_pair(self.root, self.compose, self.key, self.plain,
                                       file_count=2 if kind == tarfile.REGTYPE else 1)
                fake = FakeDocker()
                with self.assertRaises(BackupError):
                    self.rehearsal(fake).apply()
                self.assertEqual(fake.calls, [])

    def test_cleanup_finds_resources_even_when_create_or_start_did_not_return(self) -> None:
        for failure in ("volume", "extract", "start", "query", "interrupt"):
            with self.subTest(failure=failure):
                fake = FakeDocker(failure)
                with self.assertRaises((BackupError, KeyboardInterrupt)):
                    self.rehearsal(fake).apply()
                self.assertFalse(fake.containers)
                self.assertIsNone(fake.volume)

    def test_source_volume_defaults_to_production_and_a_rehearsal_names_its_own(self) -> None:
        fake = FakeDocker()
        self.assertEqual(self.rehearsal(fake).source_volume, "hawa-production_restate_data")
        other = Rehearsal(self.pair, self.key, self.compose, fake, source_volume="hawa-chaos-r10s_chaos_restate")
        with self.assertRaisesRegex(BackupError, "not the selected single-node Restate volume"):
            other.plan()

    def test_restore_into_fills_an_empty_unmounted_volume_with_exactly_the_archive(self) -> None:
        fake = FakeVolumeDocker()
        plan, restored = Rehearsal(self.pair, self.key, self.compose, fake).restore_into("hawa-r10-target")
        self.assertEqual(fake.files, {f"{NODE}/journal": b"journal"})
        self.assertEqual(restored["regularFiles"], 1)
        self.assertTrue(restored["identicalToArchive"])
        self.assertEqual(plan.node_name, NODE)
        self.assertFalse(fake.helpers)
        extract = next(call for call in fake.calls if "-xpf" in call)
        self.assertIn("--pull=never", extract)
        self.assertIn("type=volume,source=hawa-r10-target,target=/restate-data", extract)

    def test_restore_into_refuses_before_writing(self) -> None:
        for fake, reason in ((FakeVolumeDocker(mounted=True), "mounted by a container"),
                             (FakeVolumeDocker(running_node=NODE), "never run two copies"),
                             (FakeVolumeDocker(preexisting=True), "not empty")):
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(BackupError, reason):
                    Rehearsal(self.pair, self.key, self.compose, fake).restore_into("hawa-r10-target")
                self.assertFalse(any("-xpf" in call for call in fake.calls))
        other_node = FakeVolumeDocker(running_node="hawa-restate-other")
        Rehearsal(self.pair, self.key, self.compose, other_node).restore_into("hawa-r10-target")
        with self.assertRaisesRegex(BackupError, "invalid"):
            Rehearsal(self.pair, self.key, self.compose, FakeVolumeDocker()).restore_into("--all")

    def test_restore_into_refuses_a_volume_that_differs_after_extraction(self) -> None:
        with self.assertRaisesRegex(BackupError, "differs from the archive"):
            Rehearsal(self.pair, self.key, self.compose, FakeVolumeDocker(corrupt=True)).restore_into("hawa-r10-target")

    def test_malformed_sql_and_cleanup_failure_cannot_publish_success(self) -> None:
        for query in ('{"rows":[]}', '{"rows":[{"n":true}]}', '{"rows":[{"n":-1}]}', "not json"):
            with self.subTest(query=query):
                fake = FakeDocker(query=query)
                with self.assertRaisesRegex(BackupError, "90 seconds"):
                    self.rehearsal(fake).apply()
                self.assertFalse(fake.containers)
                self.assertIsNone(fake.volume)
        with self.assertRaisesRegex(BackupError, "cleanup failed"):
            self.rehearsal(FakeDocker("cleanup")).apply()


if __name__ == "__main__":
    unittest.main()
