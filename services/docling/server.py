"""Private extraction sidecar: one job at a time, no persistence or caller-supplied paths."""
import http.server
import json
import os
import subprocess
import sys
import threading

MAX_BYTES = 20 * 1024 * 1024
gate = threading.BoundedSemaphore(1)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # No document content or caller identifiers in logs.

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def reply(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def do_GET(self):
        self.reply(200 if self.path == '/health' else 404, b'{"service":"local-docling"}')

    def do_POST(self):
        if self.path != '/parse' or self.headers.get('Content-Type') != 'application/pdf':
            return self.reply(415, b'{"error":"DOCUMENT_MEDIA_UNSUPPORTED"}')
        size = self.headers.get('Content-Length', '')
        if self.headers.get('Transfer-Encoding') or not size.isdecimal() or not 0 < int(size) <= MAX_BYTES:
            return self.reply(413, b'{"error":"DOCUMENT_SIZE_LIMIT"}')
        if not gate.acquire(blocking=False):
            return self.reply(503, b'{"error":"DOCUMENT_PARSER_BUSY"}')
        try:
            data = self.rfile.read(int(size))
            if len(data) != int(size):
                return self.reply(400, b'{"error":"DOCUMENT_INPUT_INCOMPLETE"}')
            # Fixed worker and environment. No office secrets, proxy variables or remote model calls.
            proc = subprocess.run([sys.executable, '/app/extract.py'], input=data,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30,
                env={'PATH': os.defpath, 'HOME': '/tmp', 'HF_HUB_OFFLINE': '1',
                     'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1'})
            output = proc.stdout
            if not output or len(output) > 8 * 1024 * 1024:
                return self.reply(422, b'{"error":"DOCUMENT_EXTRACTION_FAILED"}')
            self.reply(200 if proc.returncode == 0 else 422, output)
        except (TimeoutError, subprocess.TimeoutExpired):
            self.reply(504, b'{"error":"DOCUMENT_EXTRACTION_TIMEOUT"}')
        except Exception:
            self.reply(422, b'{"error":"DOCUMENT_EXTRACTION_FAILED"}')
        finally:
            gate.release()


if __name__ == '__main__':
    # HTTPServer admits no unbounded thread pool or queued subprocesses.
    http.server.HTTPServer(('0.0.0.0', 8091), Handler).serve_forever()
