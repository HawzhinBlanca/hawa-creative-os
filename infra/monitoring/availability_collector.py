#!/usr/bin/env python3
"""Independent office readiness observations. SQLite is an upload spool, never office truth."""
import argparse
import contextlib
import fcntl
import hashlib
import http.client
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import ssl
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit, urljoin
from uuid import UUID, uuid4

PROTOCOL = 'office-readiness-v1'
MAX_BODY = 4 * 1024 * 1024
UNKNOWN = dict(outcome='unknown', error='interrupted', httpStatus=None, durationMs=None)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def valid_origin(value):
    u = urlsplit(value)
    loopback = u.hostname in ('localhost', '127.0.0.1', '::1')
    if (u.scheme not in ('https', 'http') or (u.scheme == 'http' and not loopback)
            or u.username or u.password or u.path or u.query or u.fragment
            or not u.hostname or not value.isascii() or value != f'{u.scheme}://{u.netloc}'
            or u.netloc.lower() != u.netloc):
        raise ValueError('Use an exact HTTPS origin (HTTP is allowed only on loopback).')
    # Match WHATWG origin normalization used by Core.
    if u.port == (443 if u.scheme == 'https' else 80):
        raise ValueError('Omit default ports from the target origin.')
    host = '[' + u.hostname + ']' if ':' in u.hostname else u.hostname
    if u.netloc != host + (':' + str(u.port) if u.port is not None else ''):
        raise ValueError('Use a canonical target origin')
    return value


class Transport:
    """No redirects, cookies, ambient proxies, response-body logs or unbounded reads."""
    def __init__(self, origin, secret):
        self.origin, self.secret = valid_origin(origin), secret

    def request(self, path, *, auth=False, body=None, extra=None, deadline=None, limit=MAX_BODY):
        deadline = deadline or time.monotonic() + 5
        if time.monotonic() >= deadline:
            raise TimeoutError('Request deadline exceeded')
        u = urlsplit(self.origin)
        headers = {'Cache-Control': 'no-store', 'Accept-Encoding': 'identity'}
        if auth:
            headers['Authorization'] = 'Bearer ' + self.secret
        if body is not None:
            headers['Content-Type'] = 'application/json'
        headers.update(extra or {})
        remaining = max(.01, deadline - time.monotonic())
        cls = http.client.HTTPSConnection if u.scheme == 'https' else http.client.HTTPConnection
        kwargs = {'context': ssl.create_default_context()} if u.scheme == 'https' else {}
        conn = cls(u.hostname, u.port, timeout=min(remaining, 4), **kwargs)
        try:
            conn.connect()
            sock = conn.sock
            sock.settimeout(max(.01, min(4, deadline - time.monotonic())))
            conn.request('POST' if body is not None else 'GET', path, body=body, headers=headers)
            response = conn.getresponse()
            chunks, size = [], 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Response deadline exceeded')
                sock.settimeout(min(4, remaining))
                chunk = response.read1(min(65536, limit - size + 1))
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise ValueError('Response size exceeded')
                chunks.append(chunk)
            return response.status, response.getheader('Content-Type', '').split(';')[0].lower(), b''.join(chunks)
        finally:
            conn.close()


class DeskAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.root, self.modules, self.styles = False, [], []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'div' and a.get('id') == 'root':
            self.root = True
        if tag == 'script' and a.get('type') == 'module' and a.get('src'):
            self.modules.append(a['src'])
        if tag == 'link' and a.get('rel') == 'stylesheet' and a.get('href'):
            self.styles.append(a['href'])


def probe(transport, kind, monitor_id, deadline):
    start, status, commit = time.monotonic(), None, None
    try:
        nonce = str(uuid4())
        path = '/' if kind == 'desk' else '/v1/monitoring/availability/probe'
        status, mime, raw = transport.request(path, auth=kind == 'office', deadline=deadline,
            extra={'X-Hawa-Probe-Nonce': nonce} if kind == 'office' else None)
        if status in (401, 403):
            outcome, error = 'unknown', 'unauthorized'
        elif status != 200:
            outcome, error = 'unavailable', 'http_error'
        elif kind == 'office':
            v = json.loads(raw)
            if (mime != 'application/json' or not isinstance(v, dict) or v.get('schemaVersion') != 1
                    or v.get('nonce') != nonce or v.get('monitorId') != monitor_id or v.get('targetOrigin') != transport.origin
                    or any(v.get(k) is not True for k in ('ready', 'intakeStorage', 'reviewStorage', 'workflowRegistration', 'activeWorker'))):
                raise ValueError('Readiness identity or checks invalid')
            commit = v.get('buildCommit')
            if commit is not None and (not isinstance(commit, str) or not re.fullmatch('[a-f0-9]{40}', commit)):
                raise ValueError('Invalid build identity')
            outcome, error = 'available', 'none'
        else:
            if mime != 'text/html':
                raise ValueError('Desk HTML missing')
            parser = DeskAssets()
            parser.feed(raw.decode('utf-8', errors='strict'))
            if not parser.root or not parser.modules or len(parser.modules) + len(parser.styles) > 16:
                raise ValueError('Built Desk entry missing or too many assets')
            assets = []
            for reference in parser.modules + parser.styles:
                u = urlsplit(urljoin(transport.origin + '/', reference))
                if f'{u.scheme}://{u.netloc}' != transport.origin:
                    if reference in parser.modules:
                        raise ValueError('External entry script refused')
                    continue  # Optional external fonts are outside office readiness.
                if not re.fullmatch(r'/assets/[a-zA-Z0-9_./-]{1,250}', u.path) or '..' in u.path.split('/') or u.query or u.fragment or u.username or u.password:
                    raise ValueError('Only same-origin built assets may be probed')
                assets.append((u.path, reference in parser.modules))
            if not assets or len(assets) > 8 or not any(not module for _, module in assets):
                raise ValueError('Built Desk assets missing')
            for asset, module in assets:
                code, content_type, content = transport.request(asset, deadline=deadline)
                if code != 200:
                    status = code
                    return dict(outcome='unavailable', error='http_error', httpStatus=status,
                        durationMs=int((time.monotonic() - start) * 1000)), None
                expected = ('text/javascript', 'application/javascript') if module else ('text/css',)
                if content_type not in expected or not content.strip():
                    raise ValueError('Built asset response invalid')
            outcome, error = 'available', 'none'
    except (ValueError, UnicodeError, TypeError):
        outcome, error, commit = 'unavailable', 'invalid_response', None
    except (OSError, http.client.HTTPException):
        outcome, error, status, commit = 'unavailable', 'network_error', None, None
    return dict(outcome=outcome, error=error, httpStatus=status, durationMs=int((time.monotonic() - start) * 1000)), commit


class Spool:
    def __init__(self, path, monitor_id, origin):
        self.path = Path(path)
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.path.is_symlink():
            raise ValueError('Spool must not be a symlink')
        self.lock = open(os.open(str(self.path) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.db = sqlite3.connect(self.path)
            os.chmod(self.path, 0o600)
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.executescript('''CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS observations(slot INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,
                  payload TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0,receipt TEXT);''')
            config = canonical(dict(protocol=PROTOCOL, monitorId=monitor_id, targetOrigin=origin))
            with self.db:
                old = self.db.execute("SELECT value FROM metadata WHERE key='config'").fetchone()
                if old and old[0] != config:
                    raise ValueError('Monitor scope changed; use a new spool and explicit monitor identity')
                self.db.execute("INSERT OR IGNORE INTO metadata VALUES('config',?)", (config,))
                # A previous lock holder died after claiming, without retaining a complete result.
                self.db.execute('UPDATE observations SET complete=1 WHERE complete=0')
        except BaseException:
            if hasattr(self, 'db'):
                self.db.close()
            self.lock.close()
            raise
        self.monitor_id, self.origin = monitor_id, origin

    def close(self):
        self.db.close()
        self.lock.close()

    def claim(self, now):
        slot = int(now // 60) * 60
        value = dict(schemaVersion=1, observationId=str(uuid4()), monitorId=self.monitor_id, targetOrigin=self.origin,
            slotStart=iso(slot), observedAt=iso(now), completedAt=None, durationMs=None,
            probes=dict(desk=dict(UNKNOWN), office=dict(UNKNOWN)), buildCommit=None)
        with self.db:
            previous = self.db.execute("SELECT value FROM metadata WHERE key='last_slot'").fetchone()
            if previous and slot <= int(previous[0]):
                return None
            self.db.execute('INSERT INTO observations(slot,id,payload) VALUES(?,?,?)', (slot, value['observationId'], canonical(value)))
            self.db.execute("INSERT OR REPLACE INTO metadata VALUES('last_slot',?)", (str(slot),))
        return value

    def finish(self, value):
        with self.db:
            changed = self.db.execute('UPDATE observations SET payload=?,complete=1 WHERE id=? AND complete=0',
                (canonical(value), value['observationId'])).rowcount
            if changed != 1:
                raise ValueError('Observation is already immutable')

    def flush(self, transport, batch=50):
        sent, error, deadline = 0, None, time.monotonic() + 15
        rows = self.db.execute('SELECT id,payload FROM observations WHERE complete=1 AND receipt IS NULL ORDER BY slot LIMIT ?', (batch,)).fetchall()
        for identity, body in rows:
            if time.monotonic() >= deadline:
                break
            try:
                status, mime, raw = transport.request('/v1/monitoring/availability/observations', auth=True, body=body.encode(),
                    extra={'Idempotency-Key': identity}, deadline=deadline, limit=8192)
                if status not in (200, 201):
                    error = 'upload_http_' + str(status)
                    break
                receipt, value = json.loads(raw), json.loads(body)
                if (mime != 'application/json' or not isinstance(receipt, dict)
                        or receipt.get('observationId') != identity or receipt.get('monitorId') != self.monitor_id
                        or receipt.get('slotStart') != value['slotStart']
                        or receipt.get('observationSha256') != hashlib.sha256(body.encode()).hexdigest()
                        or not isinstance(receipt.get('payloadSha256'), str) or not re.fullmatch('[a-f0-9]{64}', receipt['payloadSha256'])
                        or not isinstance(receipt.get('replayed'), bool) or not isinstance(receipt.get('recordedAt'), str)):
                    raise ValueError('Receipt binding invalid')
                with self.db:
                    self.db.execute('UPDATE observations SET receipt=? WHERE id=? AND receipt IS NULL', (canonical(receipt), identity))
                sent += 1
            except (OSError, http.client.HTTPException, ValueError, TypeError):
                error = 'upload_unconfirmed'
                break
        pending = self.db.execute('SELECT count(*) FROM observations WHERE receipt IS NULL').fetchone()[0]
        return dict(uploaded=sent, pending=pending, error=error)


def collect(spool, transport, now=None):
    value = spool.claim(time.time() if now is None else now)
    if value is None:
        return False
    start = time.monotonic()
    deadline = start + 25
    value['probes']['desk'], _ = probe(transport, 'desk', spool.monitor_id, deadline)
    value['probes']['office'], value['buildCommit'] = probe(transport, 'office', spool.monitor_id, deadline)
    finished, duration = time.time(), int((time.monotonic() - start) * 1000)
    observed = datetime.fromisoformat(value['observedAt'].replace('Z', '+00:00')).timestamp()
    if duration > 60000 or finished < observed or finished > observed + 60:
        # Wall-clock jumps and exceeded observation deadlines cannot manufacture valid timing.
        value.update(completedAt=None, durationMs=None, buildCommit=None, probes=dict(desk=dict(UNKNOWN), office=dict(UNKNOWN)))
    else:
        value.update(completedAt=iso(finished), durationMs=duration)
    spool.finish(value)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spool', required=True, help='Private durable SQLite spool path')
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--once', action='store_true')
    modes.add_argument('--run', action='store_true')
    modes.add_argument('--flush', action='store_true')
    args = parser.parse_args()
    try:
        origin = valid_origin(os.environ['HAWA_AVAILABILITY_TARGET_ORIGIN'])
        monitor_id = str(UUID(os.environ['HAWA_AVAILABILITY_MONITOR_ID']))
        if UUID(monitor_id).version not in range(1, 6):
            raise ValueError('Monitor ID must be an RFC 4122 UUID')
        secret = os.environ['HAWA_AVAILABILITY_MONITOR_SECRET'].strip()
        if len(secret) < 32:
            raise ValueError('Monitor secret must contain at least 32 characters')
        transport = Transport(origin, secret)
        with contextlib.closing(Spool(args.spool, monitor_id, origin)) as spool:
            while True:
                # A process stuck below socket deadlines is killed; its preclaimed slot recovers as unknown.
                signal.alarm(45)
                if not args.flush:
                    collect(spool, transport)
                result = spool.flush(transport)
                signal.alarm(0)
                print(canonical(result), flush=True)
                if not args.run:
                    return 1 if result['error'] else 0
                time.sleep(max(.2, 60 - time.time() % 60))
    except (KeyError, ValueError, OSError, sqlite3.Error):
        # Never print exception bodies: connection errors may include credentials or remote content.
        print('{"error":"collector_configuration_or_storage_unavailable"}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
