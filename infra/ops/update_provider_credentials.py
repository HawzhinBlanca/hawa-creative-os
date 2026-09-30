#!/usr/bin/env python3
"""Atomic host credential update with value-free audit evidence (ADR-165)."""
import argparse
import fcntl
import datetime
import hashlib
import json
import os
from pathlib import Path
import tempfile
import uuid

ALLOWED = {'OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'CANVA_CLIENT_SECRET', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY'}


def atomic_private(path, data):
    fd, name = tempfile.mkstemp(prefix='.hawa-credential-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        os.replace(name, path)
        directory_fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def _update(env_file, input_dir, audit_dir, reason, actor, keys):
    if not keys or len(set(keys)) != len(keys) or not set(keys) <= ALLOWED:
        raise ValueError('Only the supported provider credential fields may be changed')
    if not reason.strip() or len(reason) > 500 or not actor.strip():
        raise ValueError('A host actor and reason are required')
    path = Path(env_file).resolve(strict=True)
    before = path.read_bytes()
    new = {key: (Path(input_dir) / key).read_text().rstrip('\n') for key in keys}
    if any(not value or any(char in value for char in '\r\n\x00') or '${' in value for value in new.values()):
        raise ValueError('Credential values must be nonempty literal single lines')
    out, seen = [], set()
    for line in before.decode().splitlines():
        key = line.split('=', 1)[0] if '=' in line and not line.startswith('#') else None
        if key in new:
            if key not in seen:
                out.append(key + '=' + new[key])
                seen.add(key)
        else:
            out.append(line)
    out += [key + '=' + new[key] for key in keys if key not in seen]
    after = ('\n'.join(out) + '\n').encode()
    audit = Path(audit_dir)
    audit.mkdir(parents=True, exist_ok=True, mode=0o700)
    action = str(uuid.uuid4())
    receipt = {'version': 1, 'actionId': action, 'status': 'pending_deployment',
               'actorType': 'host_operator', 'actor': actor, 'reason': reason,
               'changedFields': keys, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'beforeSha256': hashlib.sha256(before).hexdigest(),
               'afterSha256': hashlib.sha256(after).hexdigest()}
    # Record intent first: an interruption must never leave an unrecorded configuration change.
    atomic_private(audit / ('credential-change-' + action + '.json'), (json.dumps(receipt, indent=2) + '\n').encode())
    atomic_private(path, after)
    print('Host credential change recorded; verified deployment is required for activation.')


def update(env_file, input_dir, audit_dir, reason, actor, keys):
    path = Path(env_file).resolve(strict=True)
    with (path.parent / '.credential-update.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        _update(path, input_dir, audit_dir, reason, actor, keys)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ['env-file', 'input-dir', 'audit-dir', 'reason', 'actor']:
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('keys', nargs='+')
    args = parser.parse_args()
    update(args.env_file, args.input_dir, args.audit_dir, args.reason, args.actor, args.keys)
