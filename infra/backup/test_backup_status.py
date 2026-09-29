import hashlib
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from backup_status import offsite_status, status


class BackupStatusTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.now=datetime(2026,9,27,12,tzinfo=timezone.utc).timestamp()
        self.stamp='20260927T110000Z'
        self.log=self.root/'backup.log'

    def successful(self):
        data=b'verified synthetic dump';digest=hashlib.sha256(data).hexdigest()
        dump=self.root/f'hawa_{self.stamp}.dump';dump.write_bytes(data)
        dump.with_suffix('.dump.sha256').write_text(digest+'\n')
        self.log.write_text(f'2026-09-27T11:00:05Z OK {self.stamp} bytes={len(data)} tasks=1 sha256={digest[:16]} blobs=1\n')
        return dump

    def test_success_uses_capture_time_and_stays_explicitly_local(self):
        self.successful();result=status(self.root,self.now)
        self.assertTrue(result['ok']);self.assertEqual(result['ageSeconds'],3600)
        self.assertIn('off-host durability and restore admission unverified',result['scope'])

    def test_fresh_dump_after_archive_failure_is_not_healthy(self):
        self.successful()
        self.log.write_text(self.log.read_text()+'2026-09-27T11:30:00Z FAIL 20260927T112900Z: archive failed\n')
        (self.root/'hawa_20260927T112900Z.dump').write_bytes(b'fresh local dump')
        self.assertIn('latest nightly backup failed',status(self.root,self.now)['reason'])

    def test_touching_a_stale_dump_cannot_refresh_its_receipt(self):
        dump=self.successful();os.utime(dump,None)
        self.assertIn('27 h old',status(self.root,self.now+26*3600)['reason'])

    def test_missing_dump_or_changed_sidecar_or_size_is_unverified(self):
        dump=self.successful();dump.unlink();self.assertFalse(status(self.root,self.now)['ok'])
        dump=self.successful();dump.with_suffix('.dump.sha256').write_text('0'*64);self.assertFalse(status(self.root,self.now)['ok'])
        dump=self.successful();dump.write_bytes(b'truncated');self.assertFalse(status(self.root,self.now)['ok'])

    def test_missing_or_malformed_receipt_and_future_clock_refuse(self):
        self.assertFalse(status(self.root,self.now)['ok'])
        self.log.write_text('not a receipt\n');self.assertFalse(status(self.root,self.now)['ok'])
        self.successful();self.log.write_text(self.log.read_text()+'2026-09-27T11:30:00Z OK broken receipt\n')
        self.assertFalse(status(self.root,self.now)['ok'])
        self.successful();self.assertIn('future',status(self.root,self.now-2*3600)['reason'])

    def test_gc_warning_is_distinct_from_backup_failure_and_later_success_recovers(self):
        self.successful();self.log.write_text('2026-09-27T10:00:00Z FAIL 20260927T095900Z: old failure\n'+self.log.read_text()+'2026-09-27T11:00:06Z GC-FAIL: collector unavailable\n')
        self.assertTrue(status(self.root,self.now)['ok'])


class OffsiteStatusTest(unittest.TestCase):
    """The off-site copy (ADR-141): expected only once offsite.log exists; failed or late is reported."""
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.now=datetime(2026,9,28,6,tzinfo=timezone.utc).timestamp()
        self.offsite=self.root/'offsite.log'

    def nightly(self, stamp, finished):
        with (self.root/'backup.log').open('a') as log:
            log.write(f'{finished} OK {stamp} bytes=1 tasks=1 sha256={"0"*16} blobs=0\n')

    def test_not_configured_is_not_expected(self):
        self.assertEqual(offsite_status(self.root,self.now),{'ok':True,'configured':False})

    def test_a_fresh_copy_of_the_newest_nightly_is_healthy(self):
        self.nightly('20260928T003000Z','2026-09-28T00:31:00Z')
        self.offsite.write_text('2026-09-28T02:30:40Z COPIED 20260928T003000Z files=10 bytes=5\n')
        result=offsite_status(self.root,self.now)
        self.assertTrue(result['ok'],result);self.assertEqual(result['snapshotStamp'],'20260928T003000Z')
        self.offsite.write_text(self.offsite.read_text()+'2026-09-28T03:30:00Z CURRENT 20260928T003000Z files=10\n')
        self.assertTrue(offsite_status(self.root,self.now)['ok'])

    def test_the_latest_failure_is_reported_until_a_later_copy(self):
        self.offsite.write_text('2026-09-28T02:30:40Z COPIED 20260928T003000Z files=10\n2026-09-28T03:00:00Z FAILED: rsync could not copy\n')
        self.assertIn('latest off-site backup copy failed',offsite_status(self.root,self.now)['reason'])
        self.offsite.write_text('2026-09-28T02:30:40Z FAILED: no archive\n')
        self.assertIn('no verified off-site backup copy yet',offsite_status(self.root,self.now)['reason'])
        self.offsite.write_text(self.offsite.read_text()+'2026-09-28T03:30:40Z COPIED 20260928T003000Z files=10\n')
        self.assertTrue(offsite_status(self.root,self.now)['ok'])

    def test_a_missed_morning_is_late(self):
        self.offsite.write_text('2026-09-27T02:30:40Z COPIED 20260927T003000Z files=10\n')
        self.assertTrue(offsite_status(self.root,self.now)['ok'])  # 29.5 h: not yet
        self.assertIn('20260927T003000Z, 30 h old',offsite_status(self.root,self.now+1800)['reason'])

    def test_a_newer_nightly_not_copied_within_six_hours_is_late(self):
        self.offsite.write_text('2026-09-27T09:10:00Z COPIED 20260927T090000Z files=10\n')  # a manual run
        self.nightly('20260928T003000Z','2026-09-28T00:31:00Z')
        self.assertTrue(offsite_status(self.root,self.now)['ok'])  # 5.5 h after the nightly finished
        self.assertIn('has not taken the nightly backup of 20260928T003000Z (6 h',offsite_status(self.root,self.now+3600)['reason'])


if __name__=='__main__': unittest.main()
