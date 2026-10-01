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
from urllib.parse import urlsplit, urlunsplit

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


def bound_private(path, content):
    """Preserve the inode Docker bound, including a release's link to the shared file."""
    # The caller holds .service-boundaries.lock; never expose a partially written include to reload.
    with path.open('r+' if path.exists() else 'x+') as target:
        os.fchmod(target.fileno(), 0o600)
        target.seek(0)
        if target.read() == content:
            return
        target.seek(0)
        target.write(content)
        target.truncate()
        target.flush()
        os.fsync(target.fileno())


def prepare(directory, rotate_design=False):
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
            if set(values) not in ({'HAWA_OFFICE_PROXY_PROOF', 'HAWA_DESIGN_WORKER_TOKEN'},
                                  {'HAWA_OFFICE_PROXY_PROOF', 'HAWA_DESIGN_WORKER_TOKEN', 'HAWA_DESIGN_WORKER_TOKEN_PREVIOUS'}) or \
                not re.fullmatch('[a-f0-9]{64}', values.get('HAWA_OFFICE_PROXY_PROOF', '')) or \
                not re.fullmatch('[A-Za-z0-9._:-]{32,200}', values.get('HAWA_DESIGN_WORKER_TOKEN', '')):
                raise ValueError('Invalid service boundary file; coordinate rotation before deploying')
            if 'HAWA_DESIGN_WORKER_TOKEN_PREVIOUS' in values and not re.fullmatch(
                    '[A-Za-z0-9._:-]{32,200}', values['HAWA_DESIGN_WORKER_TOKEN_PREVIOUS']):
                raise ValueError('Invalid previous design credential')
        else:
            values = {'HAWA_OFFICE_PROXY_PROOF': secrets.token_hex(32), 'HAWA_DESIGN_WORKER_TOKEN': secrets.token_hex(32)}
        aliases = {'HAWA_BEARER_TOKEN', 'HAWA_API_KEY', 'HAWA_DESK_SECRET'}
        old = values['HAWA_DESIGN_WORKER_TOKEN']
        legacy_shared = any(source.get(key) == old for key in aliases)
        if legacy_shared and rotate_design:
            if 'HAWA_DESIGN_WORKER_TOKEN_PREVIOUS' in values:
                raise ValueError('A previous design rotation is still retained; do not overwrite its drain identity')
            values['HAWA_DESIGN_WORKER_TOKEN_PREVIOUS'] = old
            values['HAWA_DESIGN_WORKER_TOKEN'] = secrets.token_hex(32)
        previous = values.get('HAWA_DESIGN_WORKER_TOKEN_PREVIOUS')
        replacements = {key for key in aliases if previous and source.get(key) == previous}
        operator = secrets.token_hex(32) if replacements else None
        source = {key: operator if key in replacements else value for key, value in source.items()}
        if len(set(values.values())) != len(values) or any(
                value == credential for key, value in source.items() for credential in values.values()
                if not (legacy_shared and not rotate_design and key in aliases and credential == old)):
            raise ValueError('Service boundary credentials must be distinct from each other and office credentials')
        # Do not allow the canonical provider file to shadow these dedicated values.
        if any(key in source for key in values):
            raise ValueError('Service boundary keys belong only in .env.service-boundaries')
        db_path = directory / '.env.worker-db'
        interpolation_path = directory / '.env'
        interpolation = env_lines(interpolation_path) if interpolation_path.exists() else {}
        # Compose's explicit environment DATABASE_URL overrides its env_file. Match that precedence.
        core_url = urlsplit(interpolation.get('DATABASE_URL', source.get('DATABASE_URL', '')))
        if core_url.scheme not in {'postgres', 'postgresql'} or not core_url.hostname or not core_url.path or not core_url.password:
            raise ValueError('A literal canonical DATABASE_URL is required for separate worker database access')
        if db_path.exists():
            db_values = env_lines(db_path)
            if set(db_values) != {'WORKER_DATABASE_URL'}:
                raise ValueError('Invalid worker database configuration')
            worker_url_text = db_values['WORKER_DATABASE_URL']
        else:
            netloc = 'hawa_worker_login:' + secrets.token_urlsafe(32) + '@' + core_url.netloc.rsplit('@', 1)[-1]
            worker_url_text = urlunsplit(core_url._replace(netloc=netloc))
        worker_url = urlsplit(worker_url_text)
        if worker_url.username != 'hawa_worker_login' or not worker_url.password or len(worker_url.password) < 32 or \
                worker_url.password == core_url.password or \
                (worker_url.scheme, worker_url.hostname, worker_url.port, worker_url.path, worker_url.query) != \
                (core_url.scheme, core_url.hostname, core_url.port, core_url.path, core_url.query):
            raise ValueError('Worker database URL must have its own restricted login/password and the canonical database target')
        if replacements:
            # Persist the drain identity before retiring aliases; a retry can complete either side.
            atomic_private(boundary.resolve(), ''.join(key + '=' + value + '\n' for key, value in values.items()))
            path = (directory / '.env.production').resolve()
            text = path.read_text()
            for key in replacements:
                text = re.sub(r'^' + key + r'=.*$', key + '=' + operator, text, flags=re.MULTILINE)
            atomic_private(path, text)
        atomic_private(db_path.resolve(), 'WORKER_DATABASE_URL=' + worker_url_text + '\n')
        revision = hashlib.sha256((directory / '.env.production').read_bytes()).hexdigest()
        core = {**values, 'HAWA_CONFIGURATION_REVISION': revision}
        atomic_private(boundary, ''.join(key + '=' + value + '\n' for key, value in core.items()))
        bound_private(directory / '.office-proxy-header.conf',
                       'proxy_set_header X-Hawa-Office-Proof "' + values['HAWA_OFFICE_PROXY_PROOF'] + '";\n')
        worker = {key: value for key, value in source.items() if key in WORKER_KEYS}
        worker['DATABASE_URL'] = worker_url_text
        worker['HAWA_DESIGN_WORKER_TOKEN'] = values['HAWA_DESIGN_WORKER_TOKEN']
        worker['HAWA_CONFIGURATION_REVISION'] = revision
        atomic_private(directory / '.env.worker', ''.join(key + '=' + value + '\n' for key, value in worker.items()))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--rotate-design', action='store_true', help='Coordinate retired operator alias and design credential rotation after release gates/backup')
    args = parser.parse_args()
    prepare(args.directory, args.rotate_design)
    print('Service boundary files prepared (values withheld).')
