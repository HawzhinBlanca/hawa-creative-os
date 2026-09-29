"""Off-site copy of the newest complete encrypted recovery set (ADR-141). Every archive is synthetic,
every destination a temporary directory; nothing here reaches production or the network."""
from __future__ import annotations

import fcntl
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from restate_nightly import manifest_mac, pair_inputs, publish_pair, sha256
from offsite_copy import BackupError, PathDestination, RsyncDestination, newest_complete, prune

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WRAPPER = HERE / "offsite_copy.sh"


def rsync_is_gnu() -> bool:
    try:
        out = subprocess.run(["rsync", "--version"], capture_output=True, text=True, check=False).stdout
    except FileNotFoundError:
        return False
    return out.startswith("rsync  version 3")


class OffsiteCopyTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix="hawa-offsite-test-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.archive = self.root / "archive"
        (self.archive / "blobs").mkdir(parents=True)
        (self.archive / "blobs" / "index.tsv").write_text("")
        self.dest = self.root / "offsite"
        self.snapshots = self.root / "snapshots"
        self.home = self.root / "home"
        self.home.mkdir()
        self.key = self.root / "passphrase"
        self.key.write_text("-".join(["synthetic", "offsite", "key"]) + "\n")

    # --- a synthetic archive, shaped as nightly_backup.sh and restate_nightly.py publish it ---
    def pack(self, stamp: str, files: list[str]) -> None:
        pack = f"blobpack_{stamp}.tar.enc"
        (self.archive / "blobs" / pack).write_bytes(f"encrypted pack {stamp} {files}".encode())
        with (self.archive / "blobs" / "index.tsv").open("a") as index:
            for name in files:
                index.write(f"{name}\t{pack}\n")

    @staticmethod
    def blob(n: int) -> str:
        digest = f"{n:064x}"
        return f"sha256/{digest[:2]}/{digest}.png"

    def night(self, stamp: str, files: list[str], new: list[str] | None = None, paired: bool = True) -> None:
        if new:
            self.pack(stamp, new)
        dump = self.archive / f"hawa_{stamp}.dump.enc"
        dump.write_bytes(f"synthetic encrypted dump {stamp}".encode() * 50)
        dump.with_name(f"{dump.name}.sha256").write_text(sha256(dump) + "\n")
        (self.archive / f"hawa_{stamp}.blobs").write_text("".join(f"{f}\n" for f in files))
        if paired:
            publish_pair(self.archive, stamp, pair_inputs(self.archive, stamp), self.restate(stamp), self.key)

    def restate(self, stamp: str) -> Path:
        plain = self.root / f"restate_{stamp}.tar"
        with tarfile.open(plain, "w") as tar:
            node = tarfile.TarInfo("./hawa-restate-prod-1/state")
            payload = f"durable state at {stamp}".encode()
            node.size = len(payload)
            tar.addfile(node, io.BytesIO(payload))
        manifest = self.archive / f"restate_{stamp}.json"
        encrypted = manifest.with_suffix(".tar.enc")
        result = subprocess.run(["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "100000", "-salt",
                                 "-in", str(plain), "-out", str(encrypted), "-pass", f"file:{self.key}"],
                                capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        facts = {"schemaVersion": 2, "encrypted": True, "nodeName": "hawa-restate-prod-1",
                 "capturedAt": datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).isoformat(),
                 "encryptedSha256": sha256(encrypted), "plaintextSha256": sha256(plain), "regularFiles": 1,
                 "crossStoreAtomic": False}
        facts["manifestMac"] = manifest_mac(facts, self.key)
        manifest.write_text(json.dumps(facts) + "\n")
        return manifest

    def env(self, **extra: str) -> dict[str, str]:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(self.home),
               "HAWA_BACKUP_ARCHIVE_DEST": str(self.archive), "HAWA_BACKUP_ARCHIVE_KEYFILE": str(self.key),
               "HAWA_BACKUP_SNAPSHOT_DIR": str(self.snapshots), "HAWA_OFFSITE_DEST": str(self.dest),
               "HAWA_BACKUP_NOTIFY_ENV": str(self.root / "no-such-env-file"), "HAWA_RESTATE_BACKUP_ENABLED": "on"}
        env.update(extra)
        return env

    def copy(self, **extra: str) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", str(WRAPPER)], env=self.env(**extra), cwd=ROOT, capture_output=True,
                              text=True, timeout=120, check=False)

    def log(self) -> list[str]:
        path = self.snapshots / "offsite.log"
        return path.read_text().splitlines() if path.exists() else []

    # --- the tests ---
    def test_not_configured_does_nothing_and_writes_nothing(self) -> None:
        self.night("20260927T003000Z", [])
        result = self.copy(HAWA_OFFSITE_DEST="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("not configured", result.stdout)
        self.assertFalse(self.dest.exists())
        self.assertFalse(self.snapshots.exists())

    def test_copies_the_newest_paired_set_verifies_it_and_is_idempotent(self) -> None:
        self.night("20260927T003000Z", [self.blob(1)], new=[self.blob(1)])
        self.night("20260928T003000Z", [self.blob(1), self.blob(2)], new=[self.blob(2)])
        result = self.copy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        line = self.log()[-1]
        self.assertRegex(line, r"^\S+ COPIED 20260928T003000Z files=10 bytes=\d+ verified=sha256-readback pruned_sets=0 ")
        stamp = "20260928T003000Z"
        receipt = json.loads((self.dest / f"hawa_{stamp}.offsite.json").read_text())
        names = {m["path"] for m in receipt["members"]}
        pair = json.loads((self.archive / f"hawa_{stamp}.restate.json").read_text())
        self.assertEqual(names, {f"hawa_{stamp}.dump.enc", f"hawa_{stamp}.dump.enc.sha256", f"hawa_{stamp}.blobs",
                                 f"hawa_{stamp}.restate.json", pair["restateManifestName"],
                                 pair["restateManifestName"].replace(".json", ".tar.enc"),
                                 "blobs/blobpack_20260927T003000Z.tar.enc", "blobs/blobpack_20260928T003000Z.tar.enc",
                                 f"hawa_{stamp}.index.tsv"})
        for member in receipt["members"]:
            self.assertEqual(sha256(self.dest / member["path"]), member["sha256"], member["path"])
            if not member["path"].endswith(".index.tsv"):
                self.assertEqual(member["sha256"], sha256(self.archive / member["path"]))
        self.assertEqual((self.dest / f"hawa_{stamp}.index.tsv").read_text(),
                         f"{self.blob(1)}\tblobpack_20260927T003000Z.tar.enc\n{self.blob(2)}\tblobpack_20260928T003000Z.tar.enc\n")
        self.assertEqual(oct((self.dest / f"hawa_{stamp}.dump.enc").stat().st_mode & 0o777), "0o600")
        # The older night is not copied: only the newest complete set.
        self.assertFalse((self.dest / "hawa_20260927T003000Z.dump.enc").exists())
        before = (self.dest / f"hawa_{stamp}.dump.enc").stat().st_mtime_ns
        again = self.copy()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertRegex(self.log()[-1], r"^\S+ CURRENT 20260928T003000Z ")
        self.assertEqual((self.dest / f"hawa_{stamp}.dump.enc").stat().st_mtime_ns, before)

    def test_a_damaged_copy_at_the_destination_is_copied_again(self) -> None:
        stamp = "20260928T003000Z"
        self.night(stamp, [self.blob(1)], new=[self.blob(1)])
        self.assertEqual(self.copy().returncode, 0)
        (self.dest / f"hawa_{stamp}.dump.enc").write_bytes(b"bit rot")
        result = self.copy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(self.log()[-1], rf"^\S+ COPIED {stamp} ")
        self.assertEqual(sha256(self.dest / f"hawa_{stamp}.dump.enc"), sha256(self.archive / f"hawa_{stamp}.dump.enc"))

    def test_an_incomplete_newest_night_falls_back_to_the_last_complete_set(self) -> None:
        self.night("20260927T003000Z", [self.blob(1)], new=[self.blob(1)])
        self.night("20260928T003000Z", [self.blob(1)])
        pair = json.loads((self.archive / "hawa_20260928T003000Z.restate.json").read_text())
        (self.archive / pair["restateManifestName"]).with_suffix(".tar.enc").unlink()
        result = self.copy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(self.log()[-1], r"^\S+ COPIED 20260927T003000Z .* skipped_newer=1$")

    def test_a_night_without_its_pair_is_not_complete_once_the_archive_holds_pairs(self) -> None:
        self.night("20260927T003000Z", [], paired=True)
        self.night("20260928T003000Z", [], paired=False)
        chosen, skipped = newest_complete(self.archive, self.key, restate_on=False)
        self.assertEqual(chosen.stamp, "20260927T003000Z")
        self.assertIn("no paired Restate copy", skipped[0])

    def test_a_changed_dump_or_a_missing_pack_is_not_complete(self) -> None:
        self.night("20260928T003000Z", [self.blob(1)], new=[self.blob(1)])
        (self.archive / "blobs" / "blobpack_20260928T003000Z.tar.enc").unlink()
        with self.assertRaisesRegex(BackupError, "pack blobpack_20260928T003000Z.tar.enc is missing"):
            newest_complete(self.archive, self.key, restate_on=True)
        self.night("20260929T003000Z", [])
        (self.archive / "hawa_20260929T003000Z.dump.enc").write_bytes(b"changed after the checksum")
        with self.assertRaisesRegex(BackupError, "does not match its checksum"):
            newest_complete(self.archive, self.key, restate_on=True)

    def test_an_unencrypted_archive_is_never_copied_off_site(self) -> None:
        (self.archive / "hawa_20260928T003000Z.dump").write_bytes(b"plain dump")
        result = self.copy(HAWA_RESTATE_BACKUP_ENABLED="off")
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertRegex(self.log()[-1], r"^\S+ FAILED: off-site copy refused: the archive holds only unencrypted dumps")
        self.assertFalse(self.dest.exists())

    def test_retention_keeps_the_newest_sets_and_every_pack_they_need(self) -> None:
        self.night("20260926T003000Z", [self.blob(9)], new=[self.blob(9)])
        self.night("20260927T003000Z", [self.blob(1)], new=[self.blob(1)])
        self.night("20260928T003000Z", [self.blob(1), self.blob(2)], new=[self.blob(2)])
        # Copy each night in turn, as three mornings would.
        for keep_dump in ("20260926T003000Z", "20260927T003000Z"):
            later = sorted(p.name for p in self.archive.glob("hawa_*.dump.enc") if p.name > f"hawa_{keep_dump}.dump.enc")
            hidden = self.root / "hidden"
            hidden.mkdir(exist_ok=True)
            for name in later:
                shutil.move(str(self.archive / name), hidden / name)
            self.assertEqual(self.copy(HAWA_OFFSITE_KEEP="2").returncode, 0)
            for name in later:
                shutil.move(str(hidden / name), self.archive / name)
        result = self.copy(HAWA_OFFSITE_KEEP="2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(self.log()[-1], r"^\S+ COPIED 20260928T003000Z .* pruned_sets=1 pruned_packs=1 ")
        left = sorted(str(p.relative_to(self.dest)) for p in self.dest.rglob("*") if p.is_file())
        self.assertNotIn("hawa_20260926T003000Z.offsite.json", left)
        self.assertNotIn("hawa_20260926T003000Z.dump.enc", left)
        self.assertNotIn("blobs/blobpack_20260926T003000Z.tar.enc", left)
        self.assertIn("blobs/blobpack_20260927T003000Z.tar.enc", left)  # still needed by both kept sets
        self.assertIn("hawa_20260927T003000Z.offsite.json", left)
        self.assertIn("hawa_20260928T003000Z.offsite.json", left)

    def test_retention_never_deletes_a_name_it_does_not_own(self) -> None:
        dest = PathDestination(self.dest)
        receipts = {"20260926T003000Z": {"members": [{"path": "../../etc/passwd"}]},
                    "20260927T003000Z": {"members": []}}
        with self.assertRaisesRegex(BackupError, "does not own"):
            prune(dest, receipts, keep=1, current="20260927T003000Z")
        # A receipt that is not a JSON object names no member: only the receipt itself goes.
        pruned = prune(dest, {"20260925T003000Z": "not a receipt", "20260927T003000Z": {"members": []}},
                       keep=1, current="20260927T003000Z")
        self.assertEqual(pruned["prunedSets"], ["20260925T003000Z"])

    def test_waits_for_the_nightly_lock_then_reports_it(self) -> None:
        self.night("20260928T003000Z", [])
        lock = open(self.archive / ".restate-backup.lock", "w")
        self.addCleanup(lock.close)
        fcntl.flock(lock, fcntl.LOCK_EX)
        result = self.copy(HAWA_OFFSITE_LOCK_WAIT_SECONDS="0")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertRegex(self.log()[-1], r"FAILED: the archive stayed locked for 0 s")
        self.assertFalse(self.dest.exists())

    def test_a_standby_or_retired_host_copies_nothing(self) -> None:
        self.night("20260928T003000Z", [])
        for role in ("retired", "standby"):
            result = self.copy(HAWA_HOST_ROLE=role)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"this host is {role}", result.stdout)
        (self.home / ".hawa").mkdir()
        (self.home / ".hawa" / "host-role").write_text("retired\n")
        self.assertIn("this host is retired", self.copy().stdout)
        self.assertFalse(self.dest.exists())
        self.assertEqual(self.log(), [])

    @unittest.skipUnless(rsync_is_gnu(), "rsync 3 (GNU) is the server's rsync; macOS ships openrsync")
    def test_rsync_transport_copies_verifies_and_prunes_the_same_way(self) -> None:
        self.night("20260926T003000Z", [self.blob(9)], new=[self.blob(9)])
        self.night("20260927T003000Z", [self.blob(1)], new=[self.blob(1)])
        hidden = self.root / "hidden"
        hidden.mkdir()
        shutil.move(str(self.archive / "hawa_20260927T003000Z.dump.enc"), hidden / "d")
        self.assertEqual(self.copy(HAWA_OFFSITE_TRANSPORT="rsync", HAWA_OFFSITE_KEEP="1").returncode, 0)
        shutil.move(str(hidden / "d"), self.archive / "hawa_20260927T003000Z.dump.enc")
        result = self.copy(HAWA_OFFSITE_TRANSPORT="rsync", HAWA_OFFSITE_KEEP="1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertRegex(self.log()[-1], r"^\S+ COPIED 20260927T003000Z files=\d+ bytes=\d+ verified=rsync-checksum pruned_sets=1 pruned_packs=1 ")
        left = sorted(str(p.relative_to(self.dest)) for p in self.dest.rglob("*") if p.is_file())
        self.assertFalse([name for name in left if "20260926" in name], left)
        again = self.copy(HAWA_OFFSITE_TRANSPORT="rsync", HAWA_OFFSITE_KEEP="1")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertRegex(self.log()[-1], r"^\S+ CURRENT 20260927T003000Z ")
        (self.dest / "hawa_20260927T003000Z.blobs").write_text("tampered\n")
        with self.assertRaisesRegex(BackupError, "differs from the archive"):
            RsyncDestination(str(self.dest), None).verify(self.archive, ["hawa_20260927T003000Z.blobs"])


if __name__ == "__main__":
    unittest.main()
