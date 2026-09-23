"""The cut-out service: one HTTP endpoint in front of core.Cutter, on the internal network only.

POST /v1/faces           body: the photo's bytes -> {"faces": [...], "focus": {"x", "y"}} (no matting; fast)
POST /v1/cutout          body: the photo's bytes; query: people=<n> (optional)
                         200 {"ok": true, "passed": bool, "png": base64, "shadow": {...}, "gates": {...}, ...}
                         400 when the body is not a picture; 503 while the model is loading
GET  /health             {"status": "healthy" | "loading" | "failed", "model": ..., "modelSha256": ...}

One cut at a time: an inference takes about 8 GB at 1024 x 1024, so a second request waits for the
first rather than run beside it. /health answers while a cut runs.
"""
from __future__ import annotations

import base64
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .core import Cutter

MAX_BODY = 25 * 1024 * 1024

state: dict[str, object] = {'status': 'loading', 'cutter': None, 'error': None}
lock = threading.Lock()


def load() -> None:
    try:
        cutter = Cutter(
            os.environ.get('CUTOUT_MODEL', '/models/BiRefNet-portrait-epoch_150.onnx'),
            os.environ.get('CUTOUT_FACE_MODEL', '/models/face_detection_yunet_2023mar.onnx'),
            model_sha256=os.environ.get('CUTOUT_MODEL_SHA256') or None,
            threads=int(os.environ.get('CUTOUT_THREADS', '4')),
        )
        state.update(cutter=cutter, status='healthy')
        print(f'[cutout] model loaded: {cutter.model_path} sha256 {cutter.model_sha256[:16]}', flush=True)
    except Exception as err:  # the service stays up to say why
        state.update(status='failed', error=f'{type(err).__name__}: {err}')
        print(f'[cutout] model failed to load: {state["error"]}', flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = 'hawa-cutout/1'

    def log_message(self, fmt: str, *args: object) -> None:  # one line per request, no bodies
        print(f'[cutout] {self.address_string()} {fmt % args}', flush=True)

    def reply(self, code: int, body: dict[str, object]) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if urlparse(self.path).path != '/health':
            return self.reply(404, {'ok': False, 'error': 'not found'})
        cutter = state['cutter']
        self.reply(200 if state['status'] == 'healthy' else 503, {
            'status': state['status'],
            'error': state['error'],
            'model': os.path.basename(cutter.model_path) if isinstance(cutter, Cutter) else None,
            'modelSha256': cutter.model_sha256 if isinstance(cutter, Cutter) else None,
            'busy': lock.locked(),
        })

    def do_POST(self) -> None:
        url = urlparse(self.path)
        if url.path not in ('/v1/cutout', '/v1/faces'):
            return self.reply(404, {'ok': False, 'error': 'not found'})
        cutter = state['cutter']
        if not isinstance(cutter, Cutter):
            return self.reply(503, {'ok': False, 'error': f'model {state["status"]}', 'detail': state['error']})
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY:
            return self.reply(400, {'ok': False, 'error': 'send the photo as the request body (at most 25 MB)'})
        data = self.rfile.read(length)
        if url.path == '/v1/faces':
            # Face detection only: milliseconds, and no need to wait behind a cut.
            try:
                return self.reply(200, {'ok': True, **cutter.focus(data)})
            except Exception as err:
                bad_picture = 'cannot identify image' in str(err) or 'image file is truncated' in str(err)
                return self.reply(400 if bad_picture else 500, {'ok': False, 'error': f'{type(err).__name__}: {err}'})
        people = parse_qs(url.query).get('people', [None])[0]
        expected = int(people) if people and people.isdigit() else None
        waited = time.time()
        with lock:
            waited = time.time() - waited
            try:
                r = cutter.cut(data, expected_people=expected)
            except Exception as err:
                traceback.print_exc()
                bad_picture = 'cannot identify image' in str(err) or 'image file is truncated' in str(err)
                return self.reply(400 if bad_picture else 500, {'ok': False, 'error': f'{type(err).__name__}: {err}'})
        self.reply(200, {
            'ok': True,
            'passed': r.passed,
            'png': base64.b64encode(r.png).decode(),
            'width': r.width,
            'height': r.height,
            'bbox': list(r.bbox),
            'shadow': {'png': base64.b64encode(r.shadow_png).decode(), 'width': r.shadow_width, 'height': r.shadow_height, 'x': r.shadow_x, 'y': r.shadow_y},
            'faces': r.faces,
            'gates': {k: {'ok': g.ok, 'value': g.value, 'limit': g.limit, 'hard': g.hard} for k, g in r.gates.items()},
            'stats': r.stats,
            'timings': {**r.timings, 'queued': round(waited, 3)},
            'model': os.path.basename(cutter.model_path),
            'modelSha256': cutter.model_sha256,
        })


def main() -> None:
    threading.Thread(target=load, daemon=True).start()
    port = int(os.environ.get('PORT', '8090'))
    print(f'[cutout] listening on :{port}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()


if __name__ == '__main__':
    main()
