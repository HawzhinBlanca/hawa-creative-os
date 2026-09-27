#!/usr/bin/env python3
"""Observe completed-backup freshness; local dump mtime alone cannot show archive success."""
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshots', required=True, type=Path)
    args = parser.parse_args()
    result = status(args.snapshots)
    if not result['ok']:
        print(result['reason'])
        return 1
    return 0


if __name__ == '__main__': raise SystemExit(main())
