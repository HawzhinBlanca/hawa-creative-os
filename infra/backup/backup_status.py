#!/usr/bin/env python3
"""Observe completed-backup freshness; local dump mtime alone cannot show archive success."""
from __future__ import annotations
import argparse
import re
import time
from datetime import datetime, timezone
from pathlib import Path


def status(snapshots: Path, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    latest = None
    try:
        with (snapshots / 'backup.log').open() as log:
            for line in log:
                match = re.match(r'^\S+ (OK|FAIL) ([0-9]{8}T[0-9]{6}Z)(?: |:)(.*)$', line)
                if match:
                    latest = match
                elif re.match(r'^\S+ (OK|FAIL)\b',line):
                    latest = None  # an incomplete/corrupt later outcome cannot reuse an older pass
        if latest is None:
            return {'ok':False, 'reason':'no completed nightly backup receipt'}
        if latest[1] == 'FAIL':
            return {'ok':False, 'reason':'latest nightly backup failed; inspect backup.log'}
        stamp = latest[2]
        captured = datetime.strptime(stamp, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc).timestamp()
        age = now - captured
        if age < -300:
            return {'ok':False, 'reason':'nightly backup receipt is dated in the future'}
        if age >= 26 * 3600:
            return {'ok':False, 'reason':f'last completed nightly backup is {int(age // 3600)} h old'}
        dump = snapshots / f'hawa_{stamp}.dump'
        size = re.search(r'(?:^| )bytes=([0-9]+)(?: |$)', latest[3])
        digest = re.search(r'(?:^| )sha256=([0-9a-f]{16})(?: |$)', latest[3])
        sidecar = dump.with_suffix('.dump.sha256')
        if not dump.is_file() or dump.is_symlink() or not sidecar.is_file() or sidecar.is_symlink():
            return {'ok':False, 'reason':'completed nightly backup is missing its local dump or checksum'}
        recorded = sidecar.read_text().split()
        if (size is None or digest is None or int(size[1]) <= 0 or dump.stat().st_size != int(size[1])
                or len(recorded) != 1 or not re.fullmatch(r'[0-9a-f]{64}',recorded[0])
                or not recorded[0].startswith(digest[1])):
            return {'ok':False, 'reason':'local backup metadata differs from its completed receipt'}
        return {'ok':True, 'snapshotStamp':stamp, 'ageSeconds':max(0,int(age)),
                'scope':'completed local backup receipt; off-host durability and restore admission unverified'}
    except (OSError, UnicodeError, ValueError):
        return {'ok':False, 'reason':'nightly backup receipt or local files cannot be verified'}


# The off-site copy (infra/backup/offsite_copy.sh, ADR-141) runs at 05:30, two hours after the nightly
# backup. It is expected only on a host where it has run: offsite.log exists once it was configured.
OFFSITE_MAX_AGE = 30 * 3600          # the copied set's own age: one missed night alerts about 06:30
OFFSITE_BEHIND_GRACE = 6 * 3600      # a newer nightly backup not copied within this long is late


def _utc(value: str, fmt: str) -> float:
    return datetime.strptime(value, fmt).replace(tzinfo=timezone.utc).timestamp()


def offsite_status(snapshots: Path, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    log = snapshots / 'offsite.log'
    if not log.exists():
        return {'ok': True, 'configured': False}
    try:
        latest = None
        copied = None
        with log.open() as lines:
            for line in lines:
                match = re.match(r'^\S+ (COPIED|CURRENT) ([0-9]{8}T[0-9]{6}Z)(?: |$)', line)
                if match:
                    latest = copied = match
                elif re.match(r'^\S+ FAILED\b', line):
                    latest = None
        if latest is None and copied is not None:
            return {'ok': False, 'reason': 'latest off-site backup copy failed; inspect offsite.log'}
        if copied is None:
            return {'ok': False, 'reason': 'no verified off-site backup copy yet; inspect offsite.log'}
        stamp = copied[2]
        age = now - _utc(stamp, '%Y%m%dT%H%M%SZ')
        if age >= OFFSITE_MAX_AGE:
            return {'ok': False, 'reason': f'the newest off-site backup copy is of {stamp}, {int(age // 3600)} h old'}
        nightly = None
        try:
            with (snapshots / 'backup.log').open() as backup_log:
                for line in backup_log:
                    match = re.match(r'^(\S+) OK ([0-9]{8}T[0-9]{6}Z) ', line)
                    if match:
                        nightly = match
        except OSError:
            nightly = None
        if nightly is not None and nightly[2] > stamp:
            since = now - _utc(nightly[1], '%Y-%m-%dT%H:%M:%SZ')
            if since >= OFFSITE_BEHIND_GRACE:
                return {'ok': False, 'reason': f'the off-site copy has not taken the nightly backup of {nightly[2]} '
                                               f'({int(since // 3600)} h after it finished)'}
        return {'ok': True, 'configured': True, 'snapshotStamp': stamp, 'ageSeconds': max(0, int(age))}
    except (OSError, UnicodeError, ValueError):
        return {'ok': False, 'reason': 'off-site copy log cannot be verified'}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshots', required=True, type=Path)
    args = parser.parse_args()
    results = (status(args.snapshots), offsite_status(args.snapshots))
    reasons = [result['reason'] for result in results if not result['ok']]
    if reasons:
        print('; '.join(reasons))
        return 1
    return 0


if __name__ == '__main__': raise SystemExit(main())
