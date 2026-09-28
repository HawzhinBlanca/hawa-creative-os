"""A Restate backup killed outright (ADR-127); never contacts the production Docker engine.

studio-v2's watchdog put back what a SIGKILLed backup had left (4eb16341). This branch's backup
(ADR-053/054) put Restate and the intake switch back only in a finally block, which SIGKILL never
runs: Restate stayed stopped until the watchdog's own restart, and intake stayed paused with the pause
revision lost. These tests kill a real child process in the middle of the archive step.

The fake Docker keeps its state in a JSON file, so a killed child and the parent see one engine.
"""
from __future__ import annotations

import fcntl
import io
import json
import os
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from contextlib import redirect_stderr
from pathlib import Path

HERE = Path(__file__).resolve().parent
from restate_nightly import BackupError, Config, RestateBackup, Runner, read_record  # noqa: E402


class FileDocker(Runner):
    """Docker, Core's switch API and PostgreSQL's switch row, as one file-backed fake."""

    def __init__(self, state: Path, block_archive: Path | None = None, unhealthy: bool = False,
                 operator_changes_switch: bool = False):
        self.state = state
        self.block_archive = block_archive
        self.unhealthy = unhealthy
        self.operator_changes_switch = operator_changes_switch
        if not state.exists():
            self.save({"enabled": True, "revision": 0, "restate": "running", "calls": []})

    def load(self) -> dict:
        return json.loads(self.state.read_text())

    def save(self, s: dict) -> None:
        tmp = self.state.with_suffix(".tmp")
        tmp.write_text(json.dumps(s))
        os.replace(tmp, self.state)

    @staticmethod
    def tag(revision: int) -> str:
        return f"00000000-0000-4000-a000-{revision:012d}"

    def run(self, args: list[str]) -> str:
        if args[0] == "openssl":
            return super().run(args)
        s = self.load()
        s["calls"].append(" ".join(args))
        try:
            if args[:2] in (["docker", "image"], ["docker", "volume"]):
                return "[]"
            if args[:2] == ["docker", "inspect"]:
                fmt = args[3]
                if fmt == "{{.Image}}":
                    return "sha256:" + "b" * 64
                if fmt == "{{.State.Running}}":
                    return "true" if s["restate"] == "running" else "false"
                if fmt == "{{.State.Health.Status}}":
                    return "unhealthy" if self.unhealthy or s["restate"] != "running" else "healthy"
            if args[:2] == ["docker", "compose"]:
                if args[-2:] == ["stop", "restate"]:
                    s["restate"] = "stopped"
                elif args[-4:] == ["up", "-d", "--no-deps", "restate"] and not self.unhealthy:
                    s["restate"] = "running"
                return ""
            if args[:2] == ["docker", "exec"]:
                if args[3] == "psql":
                    return "t" if s["enabled"] else "f"
                if "release" in args[-2:] or args[-1] in ("status", "pause"):
                    action = "release" if "release" in args[-2:] else args[-1]
                    if action == "pause":
                        s["enabled"] = False
                        s["revision"] += 1
                    elif action == "release":
                        if self.operator_changes_switch:
                            s["revision"] += 1  # an office operator toggled it after our pause
                        if args[-1] != self.tag(s["revision"]):
                            raise BackupError("docker exec failed: Core switch API answered HTTP 409")
                        s["enabled"] = True
                        s["revision"] += 1
                    return json.dumps({"channels": {"telegram": s["enabled"]}, "enabled": s["enabled"],
                                       "killSwitchActive": not s["enabled"], "changeTag": self.tag(s["revision"])})
                return "0"  # running invocations
            raise AssertionError(args)
        finally:
            self.save(s)

    def archive(self, args: list[str], path: Path) -> None:
        s = self.load()
        s["calls"].append("archive")
        self.save(s)
        if self.block_archive is not None:
            self.block_archive.write_text("in archive")
            time.sleep(120)  # the parent kills this process here
        with tarfile.open(path, "w") as out:
            item = tarfile.TarInfo("./hawa-restate-prod-1/partition/journal")
            payload = b"journal"
            item.size = len(payload)
            out.addfile(item, io.BytesIO(payload))


CHILD = r"""
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from restate_nightly import Config, RestateBackup
from test_restate_recovery import FileDocker
root = Path(sys.argv[2])
config = Config(compose_file=root / "compose.yml", compose_env=root / ".env", archive_dir=root / "archive",
                key_file=root / "key", helper_image="busybox@sha256:" + "a" * 64, drain_seconds=0,
                health_seconds=0, state_file=root / "home" / ".hawa" / "restate-backup.state")
RestateBackup(config, FileDocker(root / "docker.json", block_archive=root / "in-archive"), sleep=lambda _: None).apply()
"""


class KilledBackupTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "compose.yml").write_text("services: {restate: {image: pinned}}\n")
        (self.root / ".env").write_text("TEST_ONLY=1\n")
        (self.root / "key").write_text("synthetic-test-passphrase\n")
        (self.root / "archive").mkdir()
        self.record = self.root / "home" / ".hawa" / "restate-backup.state"
        self.docker = self.root / "docker.json"

    def config(self) -> Config:
        return Config(compose_file=self.root / "compose.yml", compose_env=self.root / ".env",
                      archive_dir=self.root / "archive", key_file=self.root / "key",
                      helper_image="busybox@sha256:" + "a" * 64, drain_seconds=0, health_seconds=0,
                      state_file=self.record)

    def kill_mid_archive(self) -> None:
        FileDocker(self.docker)  # the engine before the run: intake on, Restate running
        errors = self.root / "child.err"
        with errors.open("wb") as err:
            child = subprocess.Popen([sys.executable, "-c", CHILD, str(HERE), str(self.root)],
                                     stdout=subprocess.DEVNULL, stderr=err)
        deadline = time.monotonic() + 30
        while not (self.root / "in-archive").exists():
            if child.poll() is not None:
                self.fail(f"child ended early: {errors.read_text()}")
            if time.monotonic() > deadline:
                child.kill()
                child.wait(10)
                self.fail("child never reached the archive step")
            time.sleep(0.05)
        os.kill(child.pid, signal.SIGKILL)
        child.wait(10)
        self.assertEqual(child.returncode, -signal.SIGKILL)

    def test_sigkill_mid_archive_leaves_a_record_and_recover_puts_both_back(self) -> None:
        self.kill_mid_archive()
        engine = FileDocker(self.docker).load()
        self.assertFalse(engine["enabled"], "the killed run's pause is still in force")
        self.assertEqual(engine["restate"], "stopped", "the killed run's stop is still in force")
        record = read_record(self.record)
        assert record is not None
        self.assertEqual((record["switch"], record["restate"]), ("paused", "stopping"))
        self.assertEqual(record["changeTag"], FileDocker.tag(engine["revision"]))

        outcome = RestateBackup(self.config(), FileDocker(self.docker), sleep=lambda _: None).recover()
        self.assertEqual(outcome, "restate,kill_switch")
        engine = FileDocker(self.docker).load()
        self.assertTrue(engine["enabled"])
        self.assertEqual(engine["restate"], "running")
        self.assertFalse(self.record.exists())
        self.assertEqual([p.name for p in (self.root / "archive").iterdir() if p.name != ".restate-backup.lock"], [])
        # A second pass finds nothing to do and touches nothing.
        before = len(FileDocker(self.docker).load()["calls"])
        self.assertEqual(RestateBackup(self.config(), FileDocker(self.docker)).recover(), "none")
        self.assertEqual(len(FileDocker(self.docker).load()["calls"]), before)

    def test_recover_leaves_a_live_backup_alone(self) -> None:
        self.kill_mid_archive()
        with (self.root / "archive" / ".restate-backup.lock").open("w") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)  # a backup run that is still alive
            before = len(FileDocker(self.docker).load()["calls"])
            backup = RestateBackup(self.config(), FileDocker(self.docker))
            self.assertEqual(backup.recovery_status(), "running")
            self.assertEqual(backup.recover(), "running")
            self.assertEqual(len(FileDocker(self.docker).load()["calls"]), before)
        self.assertTrue(self.record.exists())
        self.assertEqual(RestateBackup(self.config(), FileDocker(self.docker)).recovery_status(), "needs_recovery")

    def test_a_newer_operator_decision_keeps_the_switch_and_clears_the_record(self) -> None:
        self.kill_mid_archive()
        outcome = RestateBackup(self.config(), FileDocker(self.docker, operator_changes_switch=True),
                                sleep=lambda _: None).recover()
        self.assertEqual(outcome, "restate,kill_switch_left_to_operator")
        self.assertFalse(FileDocker(self.docker).load()["enabled"])
        self.assertFalse(self.record.exists())

    def test_restate_that_does_not_come_back_keeps_intake_paused_and_the_record(self) -> None:
        self.kill_mid_archive()
        with self.assertRaisesRegex(BackupError, "did not become healthy"):
            RestateBackup(self.config(), FileDocker(self.docker, unhealthy=True), sleep=lambda _: None).recover()
        engine = FileDocker(self.docker).load()
        self.assertFalse(engine["enabled"])
        self.assertFalse(any(c.split()[-2:-1] == ["release"] for c in engine["calls"]))
        self.assertTrue(self.record.exists())

    def test_the_next_backup_first_puts_back_what_a_killed_run_left(self) -> None:
        self.kill_mid_archive()
        manifest = RestateBackup(self.config(), FileDocker(self.docker), sleep=lambda _: None).apply()
        self.assertTrue(manifest.exists())
        engine = FileDocker(self.docker).load()
        self.assertTrue(engine["enabled"])
        self.assertEqual(engine["restate"], "running")
        self.assertFalse(self.record.exists())

    def test_an_unknown_pause_revision_never_releases(self) -> None:
        FileDocker(self.docker).save({"enabled": False, "revision": 3, "restate": "running", "calls": []})
        from restate_nightly import write_record
        write_record(self.record, {"v": 1, "pid": 1, "stamp": "20260928T013000Z", "archiveDir": str(self.root / "archive"),
                                   "switch": "pausing", "changeTag": None, "restate": "running"})
        with self.assertRaisesRegex(BackupError, "pause revision was never recorded"):
            RestateBackup(self.config(), FileDocker(self.docker)).recover()
        self.assertFalse(FileDocker(self.docker).load()["enabled"])
        self.assertTrue(self.record.exists())
        # Once the office releases intake itself, the record clears.
        s = FileDocker(self.docker).load()
        s["enabled"] = True
        FileDocker(self.docker).save(s)
        self.assertEqual(RestateBackup(self.config(), FileDocker(self.docker)).recover(), "nothing_changed")
        self.assertFalse(self.record.exists())

    def test_a_completed_or_cleanly_failed_run_leaves_no_record(self) -> None:
        FileDocker(self.docker)
        manifest = RestateBackup(self.config(), FileDocker(self.docker), sleep=lambda _: None).apply()
        self.assertFalse(self.record.exists())
        # The next runs may start within the same second, whose archive name this one took.
        manifest.with_suffix(".tar.enc").unlink()
        manifest.unlink()

        class TarFails(FileDocker):
            def archive(self, args: list[str], path: Path) -> None:
                raise BackupError("synthetic tar failure after stop")

        with self.assertRaisesRegex(BackupError, "synthetic tar failure"):
            RestateBackup(self.config(), TarFails(self.docker), sleep=lambda _: None).apply()
        self.assertFalse(self.record.exists())
        self.assertTrue(FileDocker(self.docker).load()["enabled"])

        class NeverHealthy(TarFails):
            def __init__(self, state: Path):
                super().__init__(state, unhealthy=True)

        with redirect_stderr(io.StringIO()):
            with self.assertRaises(BackupError):
                RestateBackup(self.config(), NeverHealthy(self.docker), sleep=lambda _: None).apply()
        record = read_record(self.record)
        assert record is not None
        self.assertEqual((record["switch"], record["restate"]), ("paused", "stopping"))

    def test_cli_reports_status_and_recovers_nothing_without_a_record(self) -> None:
        env = {**os.environ, "HAWA_RESTATE_BACKUP_STATE": str(self.record),
               "HAWA_BACKUP_ARCHIVE_DEST": str(self.root / "archive")}
        script = str(HERE / "restate_nightly.py")
        status = subprocess.run([sys.executable, script, "--recovery-status"], env=env, capture_output=True, text=True)
        self.assertEqual((status.returncode, status.stdout.strip()), (0, "none"))
        recover = subprocess.run([sys.executable, script, "--recover"], env=env, capture_output=True, text=True)
        self.assertEqual((recover.returncode, recover.stdout.strip()), (0, "nothing to recover"))
        self.record.parent.mkdir(parents=True)
        self.record.write_text("{not json")
        broken = subprocess.run([sys.executable, script, "--recover"], env=env, capture_output=True, text=True)
        self.assertEqual(broken.returncode, 1)
        self.assertIn("unreadable", broken.stderr)
        self.kill_mid_archive_record_only()
        with (self.root / "archive" / ".restate-backup.lock").open("w") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            running = subprocess.run([sys.executable, script, "--recover"], env=env, capture_output=True, text=True)
            self.assertEqual(running.returncode, 75)
        waiting = subprocess.run([sys.executable, script, "--recovery-status"], env=env, capture_output=True, text=True)
        self.assertEqual((waiting.returncode, waiting.stdout.strip()), (2, "needs_recovery"))

    def kill_mid_archive_record_only(self) -> None:
        from restate_nightly import write_record
        write_record(self.record, {"v": 1, "pid": 1, "stamp": "20260928T013000Z", "archiveDir": str(self.root / "archive"),
                                   "switch": "none", "changeTag": None, "restate": "running"})


if __name__ == "__main__":
    unittest.main()
