"""Recovery-set retention controls; every archive is synthetic and outside production."""
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
from datetime import datetime, timedelta, timezone
from pathlib import Path

from restate_nightly import BackupError, manifest_mac, pair_inputs, pair_mac, publish_pair, sha256, verify_pair
from restate_retention import apply_retention, execute_plan, plan_retention


NOW = datetime(2026, 9, 26, 12, tzinfo=timezone.utc)


class RetentionTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix="hawa-retention-test-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.archive = self.root / "archive"
        self.archive.mkdir()
        self.key = self.root / "passphrase"
        self.key.write_text("synthetic-retention-key\n")

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
        captured_at = datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).isoformat()
        facts = {"schemaVersion": 2, "encrypted": True, "nodeName": "hawa-restate-prod-1",
                 "capturedAt": captured_at, "encryptedSha256": sha256(encrypted),
                 "plaintextSha256": sha256(plain), "regularFiles": 1, "crossStoreAtomic": False}
        facts["manifestMac"] = manifest_mac(facts, self.key)
        manifest.write_text(json.dumps(facts) + "\n")
        return manifest

    def paired(self, stamp: str) -> Path:
        dump = self.unpaired_dump(stamp)
        blob_manifest = self.archive / f"hawa_{stamp}.blobs"
        blob_manifest.write_text(f"sha256/ab/{stamp}.png\n")
        restate = self.restate(stamp)
        return publish_pair(self.archive, stamp, pair_inputs(self.archive, stamp), restate, self.key)

    def unpaired_dump(self, stamp: str) -> Path:
        dump = self.archive / f"hawa_{stamp}.dump.enc"
        dump.write_bytes(f"synthetic encrypted dump {stamp}".encode())
        dump.with_name(f"{dump.name}.sha256").write_text(sha256(dump) + "\n")
        return dump

    def test_prunes_old_complete_sets_together_and_preserves_manual_archive(self) -> None:
        stamps = ["20260920T010000Z", "20260921T010000Z", "20260922T010000Z", "20260923T010000Z"]
        for stamp in stamps:
            self.paired(stamp)
        manual = self.restate("20260919T010000Z")
        plan = plan_retention(self.archive, self.key, keep=2, now=NOW)
        self.assertEqual(plan.prune_paired, tuple(stamps[:2]))
        self.assertEqual(plan.keep_paired, tuple(reversed(stamps[2:])))
        self.assertEqual(plan.unpaired_restate_count, 1)
        self.assertGreater(plan.unpaired_restate_bytes, 0)
        self.assertTrue(all(item.path.exists() for item in plan.deletions))
        self.assertTrue((self.archive / f"hawa_{stamps[0]}.dump.enc").exists())  # plan is read-only

        applied = apply_retention(self.archive, self.key, keep=2, now=NOW)
        self.assertEqual(applied.prune_paired, tuple(stamps[:2]))
        for stamp in stamps[:2]:
            self.assertFalse((self.archive / f"hawa_{stamp}.dump.enc").exists())
            self.assertFalse((self.archive / f"hawa_{stamp}.restate.json").exists())
            self.assertFalse((self.archive / f"restate_{stamp}.tar.enc").exists())
        for stamp in stamps[2:]:
            self.assertEqual(verify_pair(self.archive / f"hawa_{stamp}.restate.json", self.key)["snapshotStamp"], stamp)
        self.assertTrue(manual.exists())
        self.assertTrue(manual.with_suffix(".tar.enc").exists())

    def test_failed_unpaired_nights_do_not_displace_complete_pairs(self) -> None:
        old, newer = "20260920T010000Z", "20260921T010000Z"
        self.paired(old)
        self.paired(newer)
        incomplete = ["20260922T010000Z", "20260923T010000Z", "20260924T010000Z"]
        for stamp in incomplete:
            self.unpaired_dump(stamp)
        plan = apply_retention(self.archive, self.key, keep=2, now=NOW)
        self.assertEqual(plan.prune_paired, ())
        self.assertEqual(plan.prune_unpaired, tuple(incomplete[:2]))
        self.assertTrue((self.archive / f"hawa_{old}.dump.enc").exists())
        self.assertTrue((self.archive / f"hawa_{incomplete[-1]}.dump.enc").exists())

    def test_24_hour_grace_preserves_recent_set_selected_by_drill(self) -> None:
        older, newer = "20260925T180000Z", "20260926T010000Z"
        self.paired(older)
        self.paired(newer)
        plan = apply_retention(self.archive, self.key, keep=1, now=NOW)
        self.assertEqual(plan.prune_paired, ())
        self.assertTrue((self.archive / f"hawa_{older}.restate.json").exists())

    def test_tampered_pair_or_newest_ciphertext_refuses_all_deletion(self) -> None:
        old, newest = "20260920T010000Z", "20260921T010000Z"
        old_pair = self.paired(old)
        self.paired(newest)
        original = old_pair.read_text()
        old_pair.write_text(original.replace('"crossStoreAtomic": false', '"crossStoreAtomic": true'))
        with self.assertRaisesRegex(BackupError, "authentication failed"):
            apply_retention(self.archive, self.key, keep=1, now=NOW)
        self.assertTrue((self.archive / f"hawa_{old}.dump.enc").exists())
        old_pair.write_text(original)
        with (self.archive / f"restate_{newest}.tar.enc").open("ab") as file:
            file.write(b"changed")
        with self.assertRaisesRegex(BackupError, "encrypted Restate archive hash differs"):
            apply_retention(self.archive, self.key, keep=1, now=NOW)
        self.assertTrue((self.archive / f"hawa_{old}.dump.enc").exists())

    def test_partial_old_prune_is_completed_from_authenticated_pair(self) -> None:
        old = "20260920T010000Z"
        self.paired(old)
        self.paired("20260921T010000Z")
        self.paired("20260922T010000Z")
        (self.archive / f"hawa_{old}.dump.enc").unlink()  # crash after deleting first old member
        plan = apply_retention(self.archive, self.key, keep=2, now=NOW)
        self.assertEqual(plan.prune_paired, (old,))
        self.assertFalse((self.archive / f"hawa_{old}.restate.json").exists())
        self.assertFalse((self.archive / f"restate_{old}.tar.enc").exists())

    def test_incomplete_newest_pair_requires_review_before_pruning(self) -> None:
        old, newest = "20260920T010000Z", "20260921T010000Z"
        self.paired(old)
        self.paired(newest)
        (self.archive / f"restate_{newest}.tar.enc").unlink()
        with self.assertRaisesRegex(BackupError, "newest paired recovery set is incomplete"):
            apply_retention(self.archive, self.key, keep=1, now=NOW)
        self.assertTrue((self.archive / f"hawa_{old}.dump.enc").exists())

    def test_duplicate_archive_ownership_and_concurrent_backup_are_refused(self) -> None:
        first, second = "20260920T010000Z", "20260921T010000Z"
        first_pair = self.paired(first)
        second_pair = self.paired(second)
        first_facts = json.loads(first_pair.read_text())
        second_facts = json.loads(second_pair.read_text())
        second_facts["restateManifestName"] = first_facts["restateManifestName"]
        second_facts["restateManifestSha256"] = first_facts["restateManifestSha256"]
        second_facts["restateCapturedAt"] = first_facts["restateCapturedAt"]
        second_facts.pop("pairMac")
        second_facts["pairMac"] = pair_mac(second_facts, self.key)
        second_pair.write_text(json.dumps(second_facts))
        with self.assertRaisesRegex(BackupError, "two paired recovery sets"):
            apply_retention(self.archive, self.key, keep=1, now=NOW)
        self.assertTrue(first_pair.exists())

        second_pair.unlink()
        with (self.archive / ".restate-backup.lock").open("w") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(BackupError, "archive lock"):
                apply_retention(self.archive, self.key, keep=1, now=NOW)

    def test_cli_plan_is_read_only_and_apply_uses_the_same_selection(self) -> None:
        old, newer = "20260920T010000Z", "20260921T010000Z"
        self.paired(old)
        self.paired(newer)
        script = Path(__file__).with_name("restate_retention.py")
        env = {**os.environ, "HAWA_BACKUP_ARCHIVE_DEST": str(self.archive),
               "HAWA_BACKUP_ARCHIVE_KEYFILE": str(self.key)}
        planned = subprocess.run([sys.executable, str(script), "--keep", "1"], env=env,
                                 capture_output=True, text=True, check=False)
        self.assertEqual(planned.returncode, 0, planned.stderr)
        facts = json.loads(planned.stdout)
        self.assertEqual(facts["status"], "planned")
        self.assertEqual(facts["prunePaired"], [old])
        self.assertTrue((self.archive / f"hawa_{old}.restate.json").exists())
        applied = subprocess.run([sys.executable, str(script), "--apply", "--keep", "1"], env=env,
                                 capture_output=True, text=True, check=False)
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual(json.loads(applied.stdout)["delete"], facts["delete"])
        self.assertFalse((self.archive / f"hawa_{old}.restate.json").exists())

    def test_stale_partial_is_cleaned_but_unpaired_ciphertext_is_reported(self) -> None:
        self.paired("20260922T010000Z")
        part = self.archive / "restate_20260920T010000Z.tar.enc.part"
        part.write_bytes(b"interrupted cold copy")
        old = (NOW - timedelta(days=2)).timestamp()
        os.utime(part, (old, old))
        orphan = self.archive / "restate_20260919T010000Z.tar.enc"
        orphan.write_bytes(b"unpaired forensic archive")
        plan = plan_retention(self.archive, self.key, keep=1, now=NOW)
        self.assertEqual(plan.stale_part_count, 1)
        self.assertEqual(plan.unpaired_restate_count, 1)
        self.assertEqual(plan.unpaired_restate_bytes, orphan.stat().st_size)
        self.assertTrue(part.exists())
        apply_retention(self.archive, self.key, keep=1, now=NOW)
        self.assertFalse(part.exists())
        self.assertTrue(orphan.exists())

    def test_changed_deletion_target_after_plan_is_refused_before_any_delete(self) -> None:
        old, newer = "20260920T010000Z", "20260921T010000Z"
        self.paired(old)
        self.paired(newer)
        plan = plan_retention(self.archive, self.key, keep=1, now=NOW)
        target = self.archive / f"restate_{old}.tar.enc"
        target.write_bytes(b"changed after retention plan")
        with self.assertRaisesRegex(BackupError, "archive changed since retention plan"):
            execute_plan(plan)
        self.assertTrue((self.archive / f"hawa_{old}.dump.enc").exists())
        self.assertTrue((self.archive / f"hawa_{old}.restate.json").exists())


if __name__ == "__main__":
    unittest.main()
