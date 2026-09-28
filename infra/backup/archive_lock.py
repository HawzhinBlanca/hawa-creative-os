#!/usr/bin/env python3
"""Hold the existing archive lock for a complete backup or restore command."""
import argparse
import fcntl
import os
import stat
import sys
from pathlib import Path


def inherited_lock(archive: Path, mode: str) -> bool:
    value = os.environ.get('HAWA_ARCHIVE_LOCK_FD')
    if value is None:
        return False
    try:
        fd = int(value)
        opened = os.fstat(fd)
        named = (archive / '.restate-backup.lock').lstat()
        held_mode = os.environ.get('HAWA_ARCHIVE_LOCK_MODE')
        if (not stat.S_ISREG(opened.st_mode) or not stat.S_ISREG(named.st_mode)
                or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)
                or held_mode not in ('shared','exclusive')
                or (mode == 'exclusive' and held_mode != 'exclusive')):
            raise ValueError('lock authority differs')
        # Reassert the inherited open-file-description lock without downgrading it.
        fcntl.flock(fd, (fcntl.LOCK_EX if held_mode == 'exclusive' else fcntl.LOCK_SH) | fcntl.LOCK_NB)
    except (ValueError, OverflowError, OSError) as exc:
        raise OSError('inherited archive lock is invalid or does not cover this operation') from exc
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive',required=True,type=Path)
    parser.add_argument('--mode',required=True,choices=['shared','exclusive'])
    parser.add_argument('--check',action='store_true')
    parser.add_argument('command',nargs=argparse.REMAINDER)
    args=parser.parse_args()
    try:
        if args.check:
            if not inherited_lock(args.archive,args.mode):
                raise OSError('archive lock was not inherited')
            return 0
        command=args.command[1:] if args.command[:1]==['--'] else args.command
        if not command:
            raise OSError('archive lock requires a command')
        args.archive.mkdir(parents=True,exist_ok=True,mode=0o700)
        fd=os.open(args.archive/'.restate-backup.lock',os.O_CREAT|os.O_RDWR|getattr(os,'O_NOFOLLOW',0),0o600)
        fcntl.flock(fd,(fcntl.LOCK_EX if args.mode=='exclusive' else fcntl.LOCK_SH)|fcntl.LOCK_NB)
        os.set_inheritable(fd,True)
        env={**os.environ,'HAWA_ARCHIVE_LOCK_FD':str(fd),'HAWA_ARCHIVE_LOCK_MODE':args.mode}
        # The command itself owns the lock; process exit/crash releases it without stale PID files.
        os.execvpe(command[0],command,env)
    except OSError:
        print('Archive operation refused: lock is busy, invalid or unavailable.',file=sys.stderr)
        return 1


if __name__=='__main__': raise SystemExit(main())
