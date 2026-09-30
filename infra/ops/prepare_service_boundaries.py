#!/usr/bin/env python3
"""ADR-163: host-local service configuration. Never print values or copy Core keys to workers."""
import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import re
import secrets
import tempfile

WORKER_KEYS = frozenset({
    'DATABASE_URL', 'HAWA_WORKER_TOKEN', 'HAWA_WORKER_TOKEN_PREVIOUS',
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'HAWA_TENANT_ID',
    'HAWA_CORE_INTERNAL_URL', 'RESTATE_INGRESS_URL', 'RESTATE_ADMIN_URL',
    'HAWA_TELEGRAM_POLLER', 'HAWA_POLLER_TAKEOVER_MS',
    'HAWA_WORKER_TAKEOVER_MS', 'HAWA_WORKER_LIVE_REFRESH_MS',
    'OUTBOX_BATCH_SIZE', 'OUTBOX_POLL_INTERVAL_MS', 'LOG_LEVEL',
    'DESIGN_PIPELINE_V3', 'DESIGN_PIPELINE_V3_CHATS', 'DESIGN_STUDIO_V2',
})


def env_lines(path):
    out = {}
    for line in path.read_text().splitlines():
        match = re.fullmatch(r'([A-Z][A-Z0-9_]*)=(.*)', line)
        if match:
            key = match[1]
            if key in out:
                raise ValueError('Duplicate environment key: ' + key)
            out[key] = match[2]
    return out


def atomic_private(path, content):
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.replace(name, path)
        directory_fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        os.chmod(path, 0o600)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def prepare(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # A concurrent prepare cannot create mismatched Core and nginx credentials.
    with (directory / '.service-boundaries.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        source = env_lines(directory / '.env.production')
        boundary = directory / '.env.service-boundaries'
        if boundary.exists():
            values = env_lines(boundary)
            revision = values.pop('HAWA_CONFIGURATION_REVISION', None)
            if revision is not None and not re.fullmatch('[a-f0-9]{64}', revision):
                raise ValueError('Invalid configuration revision')
            if set(values) != {'HAWA_OFFICE_PROXY_PROOF', 'HAWA_DESIGN_WORKER_TOKEN'} or \
                not re.fullmatch('[a-f0-9]{64}', values.get('HAWA_OFFICE_PROXY_PROOF', '')) or \
                not re.fullmatch('[A-Za-z0-9._:-]{32,200}', values.get('HAWA_DESIGN_WORKER_TOKEN', '')):
                raise ValueError('Invalid service boundary file; coordinate rotation before deploying')
        else:
            legacy = source.get('HAWA_BEARER_TOKEN', '')
            if not re.fullmatch('[A-Za-z0-9._:-]{32,200}', legacy):
                raise ValueError('A literal high-entropy legacy operator key is required for the scoped migration')
            values = {'HAWA_OFFICE_PROXY_PROOF': secrets.token_hex(32), 'HAWA_DESIGN_WORKER_TOKEN': legacy}
        if values['HAWA_DESIGN_WORKER_TOKEN'] != source.get('HAWA_BEARER_TOKEN'):
            raise ValueError('Design credential rotation must be coordinated with legacy Core rollback and draining workers')
        if len(set(values.values())) != len(values) or values['HAWA_OFFICE_PROXY_PROOF'] in source.values() or any(
            value == values['HAWA_DESIGN_WORKER_TOKEN'] for key, value in source.items() if key not in {'HAWA_BEARER_TOKEN', 'HAWA_API_KEY', 'HAWA_DESK_SECRET'}):
            raise ValueError('Service boundary credentials must be distinct from each other and office credentials')
        # Do not allow the canonical provider file to shadow these dedicated values.
        if any(key in source for key in values):
            raise ValueError('Service boundary keys belong only in .env.service-boundaries')
        revision = hashlib.sha256((directory / '.env.production').read_bytes()).hexdigest()
        core = {**values, 'HAWA_CONFIGURATION_REVISION': revision}
        atomic_private(boundary, ''.join(key + '=' + value + '\n' for key, value in core.items()))
        atomic_private(directory / '.office-proxy-header.conf',
                       'proxy_set_header X-Hawa-Office-Proof "' + values['HAWA_OFFICE_PROXY_PROOF'] + '";\n')
        worker = {key: value for key, value in source.items() if key in WORKER_KEYS}
        worker['HAWA_DESIGN_WORKER_TOKEN'] = values['HAWA_DESIGN_WORKER_TOKEN']
        worker['HAWA_CONFIGURATION_REVISION'] = revision
        atomic_private(directory / '.env.worker', ''.join(key + '=' + value + '\n' for key, value in worker.items()))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    prepare(parser.parse_args().directory)
    print('Service boundary files prepared (values withheld).')
