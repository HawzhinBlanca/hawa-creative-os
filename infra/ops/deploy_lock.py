#!/usr/bin/env python3
"""The deploy lock (ADR-240): one deploy, or one nightly live canary, at a time on this host.

    python3 infra/ops/deploy_lock.py [--lock PATH] [--wait SECONDS] -- command [args...]

Takes an exclusive flock on the lock file (HAWA_DEPLOY_LOCK, default ~/.hawa/deploy.lock), waiting up to
--wait seconds (default 0: try once), then runs the command while it holds it. The lock is this
process's own open file, never passed on (ADR-254): exec'd into the command, every process the command
started (a container daemon, a background helper outliving the deploy) inherited it and could hold the
lock after the command ended, so the canary would skip night after night. This process waits for the
command, passes SIGTERM and SIGHUP on to it, and lets go of the lock when it ends however it ends (no
stale PID file). The command sees HAWA_DEPLOY_LOCK_HELD=1, so a script that re-runs itself under the
lock does not ask for it twice. Exit 75 when the lock stays busy for the whole wait; otherwise the
command's own exit status (128 + the signal when a signal ended it).

deploy.sh --apply runs under it and waits for a canary in progress; the canary runner tries once and
skips the night when a deploy holds it, so a canary never runs during a deploy.

The holder writes its command into the lock file once it has the lock, and

    python3 infra/ops/deploy_lock.py [--lock PATH] --holder

prints that command and exits 0 while the lock is held, or exits 1 when it is free (the file keeps the last
holder's words, which mean nothing once it is free). The watchdog asks it so as not to start containers
a deploy is recreating.
"""
from __future__ import annotations

import argparse
import fcntl
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

EXIT_BUSY = 75


def lock_path(value: str | None) -> Path:
    return Path(value or os.environ.get('HAWA_DEPLOY_LOCK') or Path.home() / '.hawa' / 'deploy.lock')


def holder(path: Path) -> int:
    """0 and the holder's command while the lock is held; 1 when it is free or there is no lock file."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    except OSError:
        return 1
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            print(os.pread(fd, 600, 0).decode('utf-8', 'replace').strip())
            return 0
        fcntl.flock(fd, fcntl.LOCK_UN)
        return 1
    finally:
        os.close(fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--lock')
    parser.add_argument('--wait', type=float, default=0.0)
    parser.add_argument('--holder', action='store_true')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if args.holder:
        return holder(lock_path(args.lock))
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
    os.set_inheritable(fd, False)
    # Who holds it, for --holder (one line, the command's words; never its environment).
    try:
        os.ftruncate(fd, 0)
        os.pwrite(fd, (' '.join(command)[:500].replace('\n', ' ') + '\n').encode('utf-8', 'replace'), 0)
    except OSError:
        pass
    # Ctrl-C reaches the command from the terminal itself (same process group); this process only waits.
    # A handler, not SIG_IGN: an ignored signal would stay ignored in the command, a handler does not.
    signal.signal(signal.SIGINT, lambda _signum, _frame: None)
    try:
        child = subprocess.Popen(command, env={**os.environ, 'HAWA_DEPLOY_LOCK_HELD': '1'}, close_fds=True)
    except OSError as exc:
        print(f'deploy_lock.py could not start {command[0]}: {exc}', file=sys.stderr)
        return 127
    def forward(signum: int, _frame: object) -> None:
        child.send_signal(signum)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGHUP, forward)
    rc = child.wait()
    return 128 - rc if rc < 0 else rc


if __name__ == '__main__':
    raise SystemExit(main())
