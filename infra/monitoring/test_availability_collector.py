import contextlib
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

import availability_collector as c

ORIGIN = 'https://office.example.test'
MONITOR = '00000000-0000-4000-a000-000000000020'
HTML = b'<div id="root"></div><script type="module" src="/assets/entry.js"></script><link rel="stylesheet" href="/assets/desk.css"><link rel="stylesheet" href="https://fonts.example.test/optional.css">'


class FakeTransport:
    origin = ORIGIN
    def __init__(self):
        self.calls, self.saved, self.lost, self.failure, self.bad_receipt = [], {}, False, None, False
        self.html, self.asset_status = HTML, 200

    def request(self, path, **kwargs):
        self.calls.append((path, kwargs))
        if self.failure:
            raise self.failure
        if path == '/':
            return 200, 'text/html', self.html
        if path.startswith('/assets/'):
            return self.asset_status, 'text/javascript' if path.endswith('.js') else 'text/css', b'asset'
        if path.endswith('/probe'):
            return 200, 'application/json', json.dumps(dict(schemaVersion=1, monitorId=MONITOR, targetOrigin=ORIGIN,
                nonce=kwargs['extra']['X-Hawa-Probe-Nonce'], ready=True, intakeStorage=True, reviewStorage=True,
                workflowRegistration=True, activeWorker=True, buildCommit='a'*40)).encode()
        if path.endswith('/observations'):
            body = kwargs['body']
            value = json.loads(body)
            identity = value['observationId']
            replayed = identity in self.saved
            if replayed and self.saved[identity] != body:
                return 409, 'application/json', b'{}'
            self.saved[identity] = body
            if self.lost:
                self.lost = False
                raise ConnectionResetError('synthetic lost successful response')
            receipt = dict(observationId=identity, monitorId=MONITOR, slotStart=value['slotStart'],
                payloadSha256='a'*64, observationSha256=hashlib.sha256(body).hexdigest(),
                recordedAt=c.iso(time.time()), replayed=replayed)
            if self.bad_receipt:
                receipt['observationSha256'] = '0'*64
            return 200 if replayed else 201, 'application/json', json.dumps(receipt).encode()
        raise AssertionError('Unexpected request path')


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'spool.sqlite'
        self.spool = c.Spool(self.path, MONITOR, ORIGIN)
        self.transport = FakeTransport()

    def tearDown(self):
        self.spool.close()
        self.temp.cleanup()

    def test_claim_is_durable_unique_and_clock_rollback_never_backfills(self):
        first = self.spool.claim(1800000000)
        self.assertIsNotNone(first)
        self.assertIsNone(self.spool.claim(1800000020))
        self.assertIsNone(self.spool.claim(1799999900))
        later = self.spool.claim(1800000600)
        self.assertIsNotNone(later)
        self.assertEqual(2, self.spool.db.execute('SELECT count(*) FROM observations').fetchone()[0])

    def test_restart_recovers_incomplete_claim_as_unknown_without_another_probe(self):
        first = self.spool.claim(time.time())
        self.spool.close()
        self.spool = c.Spool(self.path, MONITOR, ORIGIN)
        payload, complete = self.spool.db.execute('SELECT payload,complete FROM observations').fetchone()
        self.assertEqual(first, json.loads(payload))
        self.assertEqual(1, complete)
        self.assertEqual('unknown', first['probes']['office']['outcome'])
        self.assertFalse(c.collect(self.spool, self.transport))
        self.assertEqual([], self.transport.calls)
        self.assertEqual(1, self.spool.flush(self.transport)['uploaded'])

    def test_process_death_after_durable_claim_recovers_same_identity(self):
        path = Path(self.temp.name) / 'killed.sqlite'
        source = 'import sys,os,signal;sys.path.insert(0,sys.argv[1]);from availability_collector import Spool; s=Spool(sys.argv[2],sys.argv[3],sys.argv[4]);s.claim(1800000000);os.kill(os.getpid(),signal.SIGKILL)'
        result = subprocess.run([sys.executable, '-c', source, str(Path(c.__file__).parent), str(path), MONITOR, ORIGIN], timeout=10, capture_output=True)
        self.assertEqual(-signal.SIGKILL, result.returncode)
        with contextlib.closing(c.Spool(path, MONITOR, ORIGIN)) as recovered:
            payload = json.loads(recovered.db.execute('SELECT payload FROM observations').fetchone()[0])
            self.assertIsNone(payload['completedAt'])
            self.assertEqual('interrupted', payload['probes']['desk']['error'])
            self.assertEqual(1, recovered.flush(self.transport)['uploaded'])
            self.assertIn(payload['observationId'], self.transport.saved)

    def test_os_lock_and_configuration_binding_survive_restart(self):
        with self.assertRaises(BlockingIOError):
            c.Spool(self.path, MONITOR, ORIGIN)
        self.spool.close()
        with self.assertRaises(ValueError):
            c.Spool(self.path, str(uuid4()), ORIGIN)
        self.spool = c.Spool(self.path, MONITOR, ORIGIN)

    def test_actual_assets_and_office_nonce_are_checked_without_third_party_requests(self):
        self.assertTrue(c.collect(self.spool, self.transport))
        value = json.loads(self.spool.db.execute('SELECT payload FROM observations').fetchone()[0])
        self.assertEqual('available', value['probes']['desk']['outcome'])
        self.assertEqual('available', value['probes']['office']['outcome'])
        self.assertEqual('a'*40, value['buildCommit'])
        self.assertEqual(['/', '/assets/entry.js', '/assets/desk.css', '/v1/monitoring/availability/probe'], [p for p, _ in self.transport.calls])
        self.assertFalse(any(k.get('auth') for p, k in self.transport.calls if not p.endswith('/probe')))
        self.assertEqual(1, self.spool.flush(self.transport)['uploaded'])
        with self.assertRaises(ValueError):
            self.spool.finish(value)

    def test_lost_successful_upload_replays_exact_bytes_after_restart(self):
        c.collect(self.spool, self.transport)
        original = self.spool.db.execute('SELECT payload FROM observations').fetchone()[0]
        self.transport.lost = True
        self.assertEqual(dict(uploaded=0, pending=1, error='upload_unconfirmed'), self.spool.flush(self.transport))
        self.spool.close()
        self.spool = c.Spool(self.path, MONITOR, ORIGIN)
        self.assertEqual(dict(uploaded=1, pending=0, error=None), self.spool.flush(self.transport))
        self.assertEqual([original.encode()], list(self.transport.saved.values()))
        self.assertEqual(1, len(self.transport.saved))
        self.assertEqual(0, self.spool.flush(self.transport)['uploaded'])

    def test_outage_survives_restart_and_backlog_recovers_without_fabricated_success(self):
        self.transport.failure = ConnectionRefusedError()
        c.collect(self.spool, self.transport)
        self.assertEqual(1, self.spool.flush(self.transport)['pending'])
        self.spool.close()
        self.spool = c.Spool(self.path, MONITOR, ORIGIN)
        self.transport.failure = None
        self.assertEqual(1, self.spool.flush(self.transport)['uploaded'])
        value = json.loads(next(iter(self.transport.saved.values())))
        self.assertEqual('unavailable', value['probes']['desk']['outcome'])
        self.assertEqual('network_error', value['probes']['office']['error'])

    def test_bad_receipt_never_acknowledges_or_discards_original(self):
        c.collect(self.spool, self.transport)
        self.transport.bad_receipt = True
        self.assertEqual(dict(uploaded=0, pending=1, error='upload_unconfirmed'), self.spool.flush(self.transport))
        self.assertIsNone(self.spool.db.execute('SELECT receipt FROM observations').fetchone()[0])

    def test_disk_write_failure_stops_before_any_network_request(self):
        self.spool.db.execute('PRAGMA query_only=ON')
        with self.assertRaises(c.sqlite3.OperationalError):
            c.collect(self.spool, self.transport)
        self.assertEqual([], self.transport.calls)

    def test_missing_or_untrusted_built_assets_cannot_pass(self):
        for html in [b'<div id="root"></div>', HTML.replace(b'/assets/entry.js', b'https://evil.test/entry.js'),
                     HTML.replace(b'/assets/entry.js', b'/assets/%2e%2e/private'), HTML.replace(b'/assets/desk.css', b'/fake.css')]:
            self.transport.html = html
            value, _ = c.probe(self.transport, 'desk', MONITOR, time.monotonic()+5)
            self.assertEqual('invalid_response', value['error'])
        self.transport.html = HTML
        self.transport.asset_status = 404
        value, _ = c.probe(self.transport, 'desk', MONITOR, time.monotonic()+5)
        self.assertEqual(404, value['httpStatus'])
        self.assertEqual('unavailable', value['outcome'])

    def test_unauthorized_is_unknown_and_old_nonce_is_not_accepted(self):
        with patch.object(self.transport, 'request', return_value=(401, 'application/json', b'{}')):
            value, _ = c.probe(self.transport, 'office', MONITOR, time.monotonic()+5)
            self.assertEqual('unknown', value['outcome'])
        with patch.object(self.transport, 'request', return_value=(200, 'application/json', b'{"nonce":"old"}')):
            value, _ = c.probe(self.transport, 'office', MONITOR, time.monotonic()+5)
            self.assertEqual('invalid_response', value['error'])

    def test_batch_is_bounded(self):
        for i in range(4):
            value = self.spool.claim(1800000000+i*60)
            self.spool.finish(value)
        self.assertEqual(dict(uploaded=2, pending=2, error=None), self.spool.flush(self.transport, batch=2))


class TransportTests(unittest.TestCase):
    def test_origin_refuses_credentials_paths_queries_fragments_and_remote_cleartext(self):
        for value in ['http://office.test', 'https://user:secret@office.test', 'https://office.test/', 'https://office.test?q=x',
                      'https://office.test#x', 'https://office.test:443', 'https://office.test:', 'https://OFFICE.test']:
            with self.assertRaises(ValueError):
                c.valid_origin(value)
        self.assertEqual('http://127.0.0.1:56081', c.valid_origin('http://127.0.0.1:56081'))

    def test_actual_http_redirect_and_oversized_bodies_are_not_followed_or_accepted(self):
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append(self.path)
                self.send_response(302 if self.path == '/redirect' else 200)
                self.send_header('Location', '/should-not-follow')
                self.end_headers()
                self.wfile.write(b'x'*200)
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            t = c.Transport(f'http://127.0.0.1:{server.server_port}', 'synthetic-secret')
            self.assertEqual(302, t.request('/redirect')[0])
            with self.assertRaises(ValueError):
                t.request('/oversized', limit=100)
            self.assertEqual(['/redirect', '/oversized'], calls)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
