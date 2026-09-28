#!/usr/bin/env python3
"""Offline synthetic archive drill. Requires cached Restate and worker image IDs; no live data."""
from __future__ import annotations

import argparse
import json
import secrets
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from restate_nightly import BackupError, inspect_tar
from restate_restore_rehearsal import IMAGE_ID, Rehearsal, Runner
from test_restate_restore_rehearsal import NODE, write_pair


WORKER = """
import http from 'node:http';
import * as restate from '@restatedev/restate-sdk';
const object = restate.object({name: 'ArchiveFixture', handlers: {
  seed: async (ctx, value) => {ctx.set('marker', value); return value;}
}});
http.createServer(restate.endpoint().bind(object).http1Handler()).listen(9080, '127.0.0.1');
"""


def curl(runner: Runner, container: str, port: int, route: str, body: dict) -> dict:
    raw = runner.run(["docker", "exec", container, "curl", "-sS", "--max-time", "10",
                                  "-H", "content-type: application/json", "-H", "accept: application/json",
                                  "--write-out", "\n%{http_code}",
                                  "-X", "POST", "--data", json.dumps(body),
                                  f"http://127.0.0.1:{port}{route}"], timeout=15)
    payload, status = raw.rsplit("\n", 1)
    if not status.startswith("2"):
        raise BackupError(f"synthetic fixture {route} HTTP {status}: {payload[-1000:]}")
    return json.loads(payload)


def eventually(action):
    deadline = time.monotonic() + 90
    while True:
        try:
            return action()
        except (BackupError, ValueError) as exc:
            if time.monotonic() >= deadline:
                raise BackupError(f"fixture did not become ready: {exc}") from exc
            time.sleep(1)


def drill(image: str, worker: str, compose: Path) -> dict:
    if not IMAGE_ID.fullmatch(image) or not IMAGE_ID.fullmatch(worker):
        raise BackupError("supply immutable locally cached image IDs")
    runner = Runner()
    for candidate in (image, worker):
        if runner.run(["docker", "image", "inspect", "--format", "{{.Id}}", candidate]) != candidate:
            raise BackupError("cached image identity differs")
    nonce = uuid.uuid4().hex[:16]
    label = f"hawa.restore-rehearsal={nonce}"
    source = f"hawa-r10-source-{nonce}"
    volume = f"hawa-r10-source-{nonce}"
    with tempfile.TemporaryDirectory(prefix="hawa-restate-fixture-") as directory:
        root = Path(directory)
        key, plain = root / "key", root / "state.tar"
        key.write_text(secrets.token_hex(32) + "\n")
        key.chmod(0o600)
        cleanup = Rehearsal(root / "unused", key, compose, runner)
        try:
            runner.run(["docker", "volume", "create", "--label", label, volume])
            runner.run(["docker", "run", "-d", "--pull=never", "--network", "none", "--name", source,
                        "--label", label, "--mount", f"type=volume,source={volume},target=/restate-data",
                        "-e", f"RESTATE_NODE_NAME={NODE}", image])
            eventually(lambda: curl(runner, source, 9070, "/query", {"query": "SELECT count(*) AS n FROM sys_invocation"}))
            runner.run(["docker", "run", "-d", "--pull=never", "--network", f"container:{source}",
                        "--label", label, "--name", f"{source}-worker", "--entrypoint", "node", worker,
                        "--input-type=module", "-e", WORKER])
            eventually(lambda: curl(runner, source, 9070, "/deployments",
                                    {"uri": "http://127.0.0.1:9080", "use_http_11": True}))
            marker = {"synthetic": True, "archiveProof": nonce}
            result = curl(runner, source, 8080, "/ArchiveFixture/proof/seed", marker)
            if result != marker:
                raise BackupError("source fixture did not persist its marker")
            state_query = {"query": "SELECT service_name, service_key, key, value_utf8 FROM state WHERE service_name = 'ArchiveFixture'"}
            source_state = curl(runner, source, 9070, "/query", state_query)["rows"]
            if len(source_state) != 1:
                raise BackupError("source fixture state missing")
            runner.run(["docker", "stop", "--time", "20", source], timeout=30)
            with plain.open("wb") as output:
                result = subprocess.run(["docker", "run", "--rm", "--pull=never", "--network", "none",
                                         "--name", f"{source}-archive", "--label", label, "--read-only",
                                         "--mount", f"type=volume,source={volume},target=/restate-data,readonly",
                                         "--entrypoint", "tar", image, "-C", "/restate-data", "-cf", "-", "."],
                                        stdout=output, stderr=subprocess.PIPE, timeout=120)
            if result.returncode:
                raise BackupError("synthetic archive copy failed")
            files = inspect_tar(plain, NODE)
            pair = write_pair(root, compose, key, plain, image=image, file_count=files)

            class CheckState(Rehearsal):
                def _query_invocations(self, container: str) -> int:
                    count = super()._query_invocations(container)
                    restored = curl(self.runner, container, 9070, "/query", state_query)["rows"]
                    if restored != source_state:
                        raise BackupError("restored synthetic object state differs")
                    return count

            rehearsal = CheckState(pair, key, compose, runner)
            rehearsal.plan()
            plan, count = rehearsal.apply()
            receipt = plan.receipt("isolated_boot_verified", count)
            receipt.update({"fixture": "synthetic", "stateRowsCompared": len(source_state),
                            "plaintextBytes": plain.stat().st_size, "journalReplayProved": False})
        finally:
            cleanup._cleanup(label, volume)
        return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--worker-image-id", required=True)
    parser.add_argument("--compose-file", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(drill(args.image_id, args.worker_image_id, args.compose_file), indent=2))
