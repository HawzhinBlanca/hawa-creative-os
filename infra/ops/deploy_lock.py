#!/usr/bin/env python3
"""The deploy lock (ADR-240): one deploy, or one nightly live canary, at a time on this host.

    python3 infra/ops/deploy_lock.py [--lock PATH] [--wait SECONDS] -- command [args...]

Takes an exclusive flock on the lock file (HAWA_DEPLOY_LOCK, default ~/.hawa/deploy.lock), waiting up to
--wait seconds (default 0: try once), then runs the command holding it: the lock is the command's open
file, so it ends with the command however the command ends (no stale PID file). The command sees
HAWA_DEPLOY_LOCK_HELD=1, so a script that re-runs itself under the lock does not ask for it twice.
Exit 75 when the lock stays busy for the whole wait; otherwise the command's own exit status.

deploy.sh --apply runs under it and waits for a canary in progress; the canary runner tries once and
skips the night when a deploy holds it, so a canary never runs during a deploy.
"""
from __future__ import annotations

import argparse
import fcntl
import os
import sys
import time
from pathlib import Path

EXIT_BUSY = 75


def lock_path(value: str | None) -> Path:
    return Path(value or os.environ.get('HAWA_DEPLOY_LOCK') or Path.home() / '.hawa' / 'deploy.lock')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--lock')
    parser.add_argument('--wait', type=float, default=0.0)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        print('deploy_lock.py needs a command to run under the lock', file=sys.stderr)
        return 64
    path = lock_path(args.lock)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    deadline = time.monotonic() + max(0.0, args.wait)
    told = False
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                print(f'deploy lock {path} is held (a deploy or the nightly canary is running)', file=sys.stderr)
                return EXIT_BUSY
            if not told:
                print(f'waiting for the deploy lock {path} (a deploy or the nightly canary is running)', file=sys.stderr)
                told = True
            time.sleep(min(5.0, max(0.1, deadline - time.monotonic())))
    os.set_inheritable(fd, True)
    os.execvpe(command[0], command, {**os.environ, 'HAWA_DEPLOY_LOCK_HELD': '1'})
    return 0  # not reached


if __name__ == '__main__':
    raise SystemExit(main())
