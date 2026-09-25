"""Local failure-path controls for ADR-053; never contact the production Docker engine."""
from __future__ import annotations

import fcntl
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

from restate_nightly import BackupError, Config, RestateBackup, Runner, inspect_tar, sha256, verify_archive, verify_pair


class FakeDocker(Runner):
    def __init__(self, fail_archive: bool = False, originally_enabled: bool = True,
                 fail_health: bool = False, operator_rethrows: bool = False):
        self.fail_archive = fail_archive
        self.fail_health = fail_health
        self.operator_rethrows = operator_rethrows
        self.enabled = originally_enabled
        self.revision = 0
        self.change_tag = "00000000-0000-4000-a000-000000000000"
        self.calls: list[str] = []

    def advance_revision(self) -> None:
        self.revision += 1
        self.change_tag = f"00000000-0000-4000-a000-{self.revision:012d}"

    def run(self, args: list[str]) -> str:
        if args[0] == "openssl":
            return super().run(args)
        self.calls.append(" ".join(args))
        if args[:2] == ["docker", "image"] or args[:2] == ["docker", "volume"]:
            return "[]"
        if args[:2] == ["docker", "inspect"]:
            fmt = args[3]
            if fmt == "{{.Image}}":
                return "sha256:" + "b" * 64
            if fmt == "{{.State.Running}}":
                return "true"
            if fmt == "{{.State.Health.Status}}":
                return "unhealthy" if self.fail_health else "healthy"
        if args[:2] == ["docker", "compose"]:
            return ""
        if args[:2] == ["docker", "exec"]:
            if args[3] == "psql":
                return "t" if self.enabled else "f"
            action = args[-2] if len(args) >= 8 and args[-2] == "release" else args[-1]
            if action in ("status", "pause", "release"):
                if action == "pause":
                    self.enabled = False
                    self.advance_revision()
                elif action == "release":
                    if args[-1] != self.change_tag:
                        raise BackupError("Core switch API answered HTTP 409")
                    self.enabled = True
                    self.advance_revision()
                return json.dumps({"channels": {"telegram": self.enabled},
                                   "enabled": self.enabled, "killSwitchActive": not self.enabled,
                                   "changeTag": self.change_tag})
            return "0"  # sys_invocation running count
        raise AssertionError(args)

    def archive(self, args: list[str], path: Path) -> None:
        self.calls.append("archive")
        if self.fail_archive:
            raise BackupError("synthetic tar failure after stop")
        with tarfile.open(path, "w") as out:
            root = tarfile.TarInfo("./hawa-restate-prod-1")
            root.type = tarfile.DIRTYPE
            out.addfile(root)
            payload = b"journal and virtual-object state"
            item = tarfile.TarInfo("./hawa-restate-prod-1/partition/journal")
            item.size = len(payload)
            out.addfile(item, io.BytesIO(payload))
        if self.operator_rethrows:
            self.advance_revision()  # another Core records a newer office decision while backup runs


class RestateBackupTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.compose = self.root / "compose.yml"
        self.env = self.root / ".env"
        self.key = self.root / "key"
        self.archive = self.root / "archive"
        self.compose.write_text("services: {restate: {image: pinned}}\n")
        self.env.write_text("TEST_ONLY=1\n")
        self.key.write_text("synthetic-test-passphrase\n")
        self.archive.mkdir()

    def config(self, image: str | None = None) -> Config:
        return Config(compose_file=self.compose, compose_env=self.env, archive_dir=self.archive,
                      key_file=self.key, helper_image=image or "busybox@sha256:" + "a" * 64,
                      drain_seconds=0, health_seconds=0)

    def night(self, stamp: str = "20260925T010203Z") -> tuple[Path, Path, Path]:
        dump = self.archive / f"hawa_{stamp}.dump.enc"
        blobs = self.archive / f"hawa_{stamp}.blobs"
        sidecar = self.archive / f"hawa_{stamp}.dump.enc.sha256"
        dump.write_bytes(b"synthetic encrypted dump")
        blobs.write_text("sha256/ab/a.txt\n")
        sidecar.write_text(sha256(dump) + "\n")
        return dump, blobs, sidecar

    def test_same_night_pair_binds_exact_dump_blobs_and_restate_archive(self) -> None:
        stamp = "20260925T010203Z"
        dump, blobs, _ = self.night(stamp)
        manifest = RestateBackup(self.config(), FakeDocker(), sleep=lambda _: None).apply(stamp)
        pair = self.archive / f"hawa_{stamp}.restate.json"
        facts = verify_pair(pair, self.key)
        self.assertEqual(facts["dumpSha256"], sha256(dump))
        self.assertEqual(facts["blobManifestSha256"], sha256(blobs))
        self.assertEqual(facts["restateManifestName"], manifest.name)
        self.assertFalse(facts["crossStoreAtomic"])
        self.assertEqual(facts["schemaVersion"], 1)

        # A newer valid archive cannot silently replace the archive recorded for this dump.
        unrelated = self.archive / "restate_20260925T235959Z.json"
        unrelated.write_bytes(manifest.read_bytes())
        unrelated.with_suffix(".tar.enc").write_bytes(manifest.with_suffix(".tar.enc").read_bytes())
        self.assertEqual(verify_archive(unrelated, self.key)["encrypted"], True)
        self.assertEqual(verify_pair(pair, self.key)["restateManifestName"], manifest.name)

    def test_pair_refuses_missing_or_changed_same_night_inputs_before_pause(self) -> None:
        stamp = "20260925T010203Z"
        fake = FakeDocker()
        with self.assertRaisesRegex(BackupError, "same-night encrypted dump"):
            RestateBackup(self.config(), fake).apply(stamp)
        self.assertEqual(fake.calls, [])
        dump, blobs, sidecar = self.night(stamp)
        blobs.unlink()
        with self.assertRaisesRegex(BackupError, "blob manifest"):
            RestateBackup(self.config(), fake).apply(stamp)
        self.assertEqual(fake.calls, [])
        blobs.write_text("sha256/ab/a.txt\n")
        sidecar.write_text("0" * 64 + "\n")
        with self.assertRaisesRegex(BackupError, "checksum differs"):
            RestateBackup(self.config(), fake).apply(stamp)
        self.assertEqual(fake.calls, [])
        dump.unlink()

    def test_later_pair_check_refuses_changed_archive_or_pair(self) -> None:
        stamp = "20260925T010203Z"
        dump, blobs, _ = self.night(stamp)
        RestateBackup(self.config(), FakeDocker(), sleep=lambda _: None).apply(stamp)
        pair = self.archive / f"hawa_{stamp}.restate.json"
        original = pair.read_bytes()
        dump.write_bytes(b"modified encrypted dump")
        with self.assertRaisesRegex(BackupError, "differs from pair: dumpName"):
            verify_pair(pair, self.key)
        dump.write_bytes(b"synthetic encrypted dump")
        blobs.write_text("changed\n")
        with self.assertRaisesRegex(BackupError, "differs from pair: blobManifestName"):
            verify_pair(pair, self.key)
        blobs.write_text("sha256/ab/a.txt\n")
        facts = json.loads(original)
        facts["restateManifestName"] = "restate_20260925T235959Z.json"
        pair.write_text(json.dumps(facts))
        with self.assertRaisesRegex(BackupError, "authentication failed"):
            verify_pair(pair, self.key)

    def test_existing_pair_is_refused_before_contacting_docker(self) -> None:
        stamp = "20260925T010203Z"
        self.night(stamp)
        RestateBackup(self.config(), FakeDocker(), sleep=lambda _: None).apply(stamp)
        fake = FakeDocker()
        with self.assertRaisesRegex(BackupError, "pair already exists"):
            RestateBackup(self.config(), fake, sleep=lambda _: None).apply(stamp)
        self.assertEqual(fake.calls, [])

    def test_changed_dump_during_capture_cannot_publish_a_pair(self) -> None:
        stamp = "20260925T010203Z"
        dump, _, _ = self.night(stamp)

        class ChangingDocker(FakeDocker):
            def archive(self, args: list[str], path: Path) -> None:
                super().archive(args, path)
                dump.write_bytes(b"changed during the Restate pause")

        fake = ChangingDocker()
        with self.assertRaisesRegex(BackupError, "changed during Restate capture"):
            RestateBackup(self.config(), fake, sleep=lambda _: None).apply(stamp)
        self.assertTrue(fake.enabled)
        self.assertFalse((self.archive / f"hawa_{stamp}.restate.json").exists())

    def test_verify_pair_cli_reports_the_bound_dump_without_docker(self) -> None:
        stamp = "20260925T010203Z"
        self.night(stamp)
        manifest = RestateBackup(self.config(), FakeDocker(), sleep=lambda _: None).apply(stamp)
        pair = self.archive / f"hawa_{stamp}.restate.json"
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("restate_nightly.py")),
                                 "--verify-pair", str(pair)],
                                env={**os.environ, "HAWA_BACKUP_ARCHIVE_KEYFILE": str(self.key)},
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"status": "verified_pair",
                                                     "dumpName": f"hawa_{stamp}.dump.enc",
                                                     "restateManifestName": manifest.name})

    def test_success_publishes_only_verified_encrypted_volume_after_healthy_restart(self) -> None:
        fake = FakeDocker()
        manifest = RestateBackup(self.config(), fake, sleep=lambda _: None).apply()
        facts = json.loads(manifest.read_text())
        self.assertTrue(fake.enabled)
        self.assertEqual(facts["regularFiles"], 1)
        self.assertFalse(facts["crossStoreAtomic"])
        self.assertEqual(facts["nodeName"], "hawa-restate-prod-1")
        self.assertEqual(facts["composeSha256"], sha256(self.compose))
        encrypted = manifest.with_suffix(".tar.enc")
        self.assertEqual(facts["encryptedSha256"], sha256(encrypted))
        self.assertEqual(facts["schemaVersion"], 2)
        self.assertEqual(len(facts["manifestMac"]), 64)
        self.assertEqual(verify_archive(manifest, self.key)["plaintextSha256"], facts["plaintextSha256"])
        self.assertIn("archive", fake.calls)
        self.assertLess(next(i for i, c in enumerate(fake.calls) if c.endswith("stop restate")),
                        fake.calls.index("archive"))
        self.assertLess(fake.calls.index("archive"),
                        next(i for i, c in enumerate(fake.calls) if c.endswith("up -d --no-deps restate")))

    def test_archive_failure_restarts_and_releases_only_our_switch(self) -> None:
        fake = FakeDocker(fail_archive=True)
        with self.assertRaisesRegex(BackupError, "synthetic tar failure"):
            RestateBackup(self.config(), fake, sleep=lambda _: None).apply()
        self.assertTrue(fake.enabled)
        self.assertFalse([path for path in self.archive.iterdir() if path.name != ".restate-backup.lock"])
        self.assertTrue(any(c.endswith("up -d --no-deps restate") for c in fake.calls))

        already_paused = FakeDocker(fail_archive=True, originally_enabled=False)
        with self.assertRaises(BackupError):
            RestateBackup(self.config(), already_paused, sleep=lambda _: None).apply()
        self.assertFalse(already_paused.enabled)
        self.assertFalse(any(" release " in c for c in already_paused.calls))

    def test_newer_operator_switch_decision_blocks_backup_release(self) -> None:
        fake = FakeDocker(operator_rethrows=True)
        with redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(BackupError, "HTTP 409"):
                RestateBackup(self.config(), fake, sleep=lambda _: None).apply()
        self.assertFalse(fake.enabled)
        self.assertFalse([path for path in self.archive.iterdir() if path.name != ".restate-backup.lock"])

    def test_stale_core_switch_is_refused_before_stopping_restate(self) -> None:
        class DisagreeingDocker(FakeDocker):
            def run(self, args: list[str]) -> str:
                if args[:2] == ["docker", "exec"] and args[3] == "psql":
                    return "f"
                return super().run(args)

        fake = DisagreeingDocker()
        with self.assertRaisesRegex(BackupError, "disagree"):
            RestateBackup(self.config(), fake).apply()
        self.assertFalse(any(c.endswith("stop restate") for c in fake.calls))

    def test_concurrent_backup_is_refused_before_preflight_or_stop(self) -> None:
        fake = FakeDocker()
        with (self.archive / ".restate-backup.lock").open("w") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(BackupError, "archive lock"):
                RestateBackup(self.config(), fake).apply()
        self.assertEqual(fake.calls, [])

    def test_failed_recovery_keeps_intake_paused_and_publishes_nothing(self) -> None:
        fake = FakeDocker(fail_health=True)
        with redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(BackupError, "did not become healthy"):
                RestateBackup(self.config(), fake, sleep=lambda _: None).apply()
        self.assertFalse(fake.enabled)
        self.assertFalse([path for path in self.archive.iterdir() if path.name != ".restate-backup.lock"])

    def test_refuses_unpinned_helper_and_wrong_or_unsafe_node_archive(self) -> None:
        fake = FakeDocker()
        with self.assertRaisesRegex(BackupError, "immutable"):
            RestateBackup(self.config("busybox:latest"), fake).preflight()
        self.assertEqual(fake.calls, [])
        path = self.root / "wrong.tar"
        with tarfile.open(path, "w") as out:
            item = tarfile.TarInfo("../wrong-node/data")
            item.size = 1
            out.addfile(item, io.BytesIO(b"x"))
        with self.assertRaisesRegex(BackupError, "unsafe path"):
            inspect_tar(path, "hawa-restate-prod-1")

        with tarfile.open(path, "w") as out:
            for name in ("./cluster-metadata", "./hawa-restate-prod-1/partition/journal"):
                item = tarfile.TarInfo(name)
                item.size = 1
                out.addfile(item, io.BytesIO(b"x"))
        self.assertEqual(inspect_tar(path, "hawa-restate-prod-1"), 2)
        with self.assertRaisesRegex(BackupError, "no data files"):
            inspect_tar(path, "another-node")

    def test_later_archive_check_refuses_changed_ciphertext(self) -> None:
        manifest = RestateBackup(self.config(), FakeDocker(), sleep=lambda _: None).apply()
        encrypted = manifest.with_suffix(".tar.enc")
        with encrypted.open("ab") as stream:
            stream.write(b"changed after backup")
        with self.assertRaisesRegex(BackupError, "hash differs"):
            verify_archive(manifest, self.key)

    def test_later_archive_check_refuses_changed_manifest(self) -> None:
        manifest = RestateBackup(self.config(), FakeDocker(), sleep=lambda _: None).apply()
        facts = json.loads(manifest.read_text())
        facts["crossStoreAtomic"] = True
        manifest.write_text(json.dumps(facts))
        with self.assertRaisesRegex(BackupError, "authentication failed"):
            verify_archive(manifest, self.key)


if __name__ == "__main__":
    unittest.main()
