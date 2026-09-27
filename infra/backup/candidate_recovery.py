#!/usr/bin/env python3
"""Coherent cold restore of a fresh synthetic candidate; never accepts production resources."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from drill_postgres_pitr import DrillError, IMAGE_ID, fingerprint, run, text
from restate_nightly import metadata_mac, sha256

ROOT = Path(__file__).resolve().parents[2]
CHAOS = ROOT / 'packages/testkit/chaos'
RUN = CHAOS / '.run'
OVERRIDE = RUN / 'recovery.compose.json'
PURPOSE = b'hawa/coherent-candidate-recovery-v1'
SERVICES = ('postgres', 'restate', 'core', 'worker-blue', 'fakes')
STORES = {'postgres': ('postgres', '/var/lib/postgresql/data', 'chaos_postgres'),
          'restate': ('restate', '/restate-data', 'chaos_restate'),
          'blobs': ('core', '/var/lib/hawa/blobs', 'chaos_blobs')}
EXTENSIONS = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
              'application/pdf': 'pdf', 'audio/ogg': 'ogg',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'}


def verify_blobs(rows: list, members: dict) -> int:
    if not rows:
        raise DrillError('the rehearsal must contain registered file bytes')
    for row in rows:
        digest = row['sha256']
        extension = EXTENSIONS.get(row['media_type'])
        if not extension or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise DrillError('invalid registered blob identity')
        member = members.get(f'sha256/{digest[:2]}/{digest}.{extension}')
        if not member or member[0] != int(row['size']) or member[-1] != digest:
            raise DrillError('registered blob missing or corrupt')
    return len(rows)


def docker(*args, **kwargs):
    return text(['docker', *args], **kwargs)


def archive_members(path: Path) -> dict:
    """Validate before extraction, including duplicate aliases and special files."""
    members = {}
    with tarfile.open(path) as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or not (member.isdir() or member.isfile()):
                raise DrillError('unsafe recovery archive member')
            key = str(name)
            if key in members:
                raise DrillError('duplicate recovery archive member')
            digest = None
            if member.isfile():
                stream = archive.extractfile(member)
                if stream is None:
                    raise DrillError('unreadable recovery archive member')
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            members[key] = [member.size, member.mode, member.uid, member.gid, digest]
    if not any(value[-1] for value in members.values()):
        raise DrillError('empty recovery archive')
    return members


def verify_manifest(manifest: dict, key: Path, directory: Path) -> None:
    facts = {k: v for k, v in manifest.items() if k != 'authenticator'}
    if not hmac.compare_digest(metadata_mac(facts, key, PURPOSE), manifest.get('authenticator', '')):
        raise DrillError('recovery manifest authentication failed')
    if set(facts['archives']) != set(STORES):
        raise DrillError('incomplete coordinated recovery set')
    for kind, member in facts['archives'].items():
        if member['filename'] != f'{kind}.tar.enc' or sha256(directory / member['filename']) != member['ciphertextSha256']:
            raise DrillError('recovery archive identity differs')


class CandidateRecovery:
    def __init__(self, task: str, started_after: str):
        self.task = str(uuid.UUID(task))
        self.started_after = datetime.fromisoformat(started_after.replace('Z', '+00:00'))
        self.nonce = uuid.uuid4().hex[:16]
        self.label = 'hawa.recovery-drill=' + self.nonce
        self.work: Path | None = None
        self.identity = {}

    def inspect(self):
        for service in SERVICES:
            value = json.loads(docker('inspect', f'hawa-chaos-{service}-1'))[0]
            labels = value['Config'].get('Labels') or {}
            created = datetime.fromisoformat(value['Created'][:26] + '+00:00')
            if labels.get('com.docker.compose.project') != 'hawa-chaos' or labels.get('com.docker.compose.service') != service:
                raise DrillError('candidate service identity refused')
            if created < self.started_after or not value['State']['Running'] or not IMAGE_ID.fullmatch(value['Image']):
                raise DrillError('requires a fresh running candidate with immutable images')
            self.identity[service] = value
        for service in ('core', 'worker-blue'):
            if not self.identity[service]['NetworkSettings']['Networks']:
                raise DrillError('provider caller has no verified internal network')
            for network in self.identity[service]['NetworkSettings']['Networks']:
                if not json.loads(docker('network', 'inspect', network))[0]['Internal']:
                    raise DrillError('provider caller has non-internal network')
        if 'RESTATE_NODE_NAME=hawa-restate-chaos-1' not in self.identity['restate']['Config']['Env']:
            raise DrillError('candidate Restate node identity differs')
        green = docker('ps', '-q', '--filter', 'name=^hawa-chaos-worker-green-1$')
        if green:
            raise DrillError('unexpected additional writer; stop before this rehearsal')
        for service, target, _ in STORES.values():
            mounts = [m for m in self.identity[service]['Mounts'] if m['Destination'] == target]
            if len(mounts) != 1 or mounts[0]['Type'] != 'volume':
                raise DrillError('store must be a named candidate volume')
            volume = json.loads(docker('volume', 'inspect', mounts[0]['Name']))[0]
            if (volume.get('Labels') or {}).get('com.docker.compose.project') != 'hawa-chaos':
                raise DrillError('store is outside the candidate project')
        if self.sql("SELECT current_setting('fsync') || '/' || current_setting('full_page_writes')") != 'on/on':
            raise DrillError('recovery candidate requires fsync and full_page_writes')

    def sql(self, query):
        return docker('exec', '-i', 'hawa-chaos-postgres-1', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                      '-U', 'hawa_owner', '-d', 'hawa_chaos', data=query.encode())

    def pending(self):
        query = ("SELECT id,target_service_key,pinned_deployment_id FROM sys_invocation "
                 f"WHERE target_service_name='Delivery' AND target_service_key LIKE 'dl-{self.task}-%' AND status <> 'completed'")
        raw = docker('exec', 'hawa-chaos-restate-1', 'curl', '-fsS', '--max-time', '10',
                     '-H', 'content-type: application/json', '-H', 'accept: application/json', '-X', 'POST',
                     '--data', json.dumps({'query': query}), 'http://127.0.0.1:9070/query')
        return json.loads(raw)['rows']

    def assert_stopped(self, services):
        for service in services:
            if docker('inspect', '--format', '{{.State.Running}}', f'hawa-chaos-{service}-1') != 'false':
                raise DrillError('writer still running during coordinated capture')

    def helper(self, volume, args, *, input_path=None, output_path=None, readonly=False):
        cmd = ['docker', 'run', '--rm', '--pull=never', '--network', 'none', '--user', 'root',
               '--name', f'hawa-recovery-{self.nonce}-helper', '--label', self.label,
               '-v', f'{volume}:/store' + (':ro' if readonly else ''), '--entrypoint', 'tar',
               self.identity['postgres']['Image'], '-C', '/store', *args]
        if input_path:
            cmd.insert(3, '-i')
        with (input_path.open('rb') if input_path else open(os.devnull, 'rb')) as inp:
            with (output_path.open('wb') if output_path else open(os.devnull, 'wb')) as out:
                result = subprocess.run(cmd, stdin=inp, stdout=out, stderr=subprocess.PIPE, timeout=180)
        if result.returncode:
            raise DrillError('candidate volume copy failed')

    def compose(self, *args):
        return text(['docker', 'compose', '-p', 'hawa-chaos', '-f', str(CHAOS/'docker-compose.chaos.yml'),
                     '-f', str(OVERRIDE), '--env-file', str(RUN/'chaos.env'), *args], timeout=240)

    def execute(self):
        self.inspect()  # Every identity check precedes stopping or creating resources.
        self.work = Path(tempfile.mkdtemp(prefix='recovery-private-', dir=RUN))
        key = self.work/'key'; key.write_text(secrets.token_hex(32)); key.chmod(0o600)
        print('Freezing candidate writers for coordinated recovery.', flush=True)
        docker('stop', '--time', '10', 'hawa-chaos-worker-blue-1', 'hawa-chaos-core-1', timeout=40)
        self.assert_stopped(('core', 'worker-blue'))
        expected = fingerprint(self.sql)
        pending = self.pending()
        if len(pending) != 1 or not pending[0]['pinned_deployment_id']:
            raise DrillError('one pinned pending delivery is required')
        docker('stop', '--time', '20', 'hawa-chaos-restate-1', 'hawa-chaos-postgres-1', timeout=60)
        self.assert_stopped(('core', 'worker-blue', 'restate', 'postgres'))
        facts = {'schemaVersion': 1, 'capturedAt': datetime.now(timezone.utc).isoformat(),
                 'taskId': self.task, 'pendingDelivery': pending, 'archives': {},
                 'images': {s: self.identity[s]['Image'] for s in SERVICES}}
        contents = {}
        for kind, (service, target, _) in STORES.items():
            source = next(m['Name'] for m in self.identity[service]['Mounts'] if m['Destination'] == target)
            plain = self.work/f'{kind}.tar'; encrypted = self.work/f'{kind}.tar.enc'
            self.helper(source, ['-cf', '-', '.'], output_path=plain, readonly=True)
            contents[kind] = archive_members(plain)
            run(['openssl', 'enc', '-aes-256-cbc', '-pbkdf2', '-iter', '100000', '-in', str(plain),
                 '-out', str(encrypted), '-pass', f'file:{key}'])
            facts['archives'][kind] = {'filename': encrypted.name, 'ciphertextSha256': sha256(encrypted),
              'plaintextSha256': sha256(plain), 'sourceVolume': source, 'bytes': plain.stat().st_size}
        facts['authenticator'] = metadata_mac(facts, key, PURPOSE)
        (self.work/'manifest.json').write_text(json.dumps(facts, indent=2)+'\n')
        verify_manifest(facts, key, self.work)
        # Authenticate and decrypt the whole set before creating any recovery volume.
        for kind in STORES:
            restored = self.work/f'{kind}.restored.tar'
            run(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '100000',
                 '-in', str(self.work/f'{kind}.tar.enc'), '-out', str(restored), '-pass', f'file:{key}'])
            if sha256(restored) != facts['archives'][kind]['plaintextSha256'] or archive_members(restored) != contents[kind]:
                raise DrillError('archive round-trip differs')
        self.assert_stopped(('core', 'worker-blue', 'restate', 'postgres'))
        override = {'services': {s: {'image': self.identity[s]['Image']} for s in ('postgres', 'restate', 'core', 'worker-blue')}, 'volumes': {}}
        override['services']['postgres']['command'] = self.identity['postgres']['Config']['Cmd']
        for kind, (_, _, logical) in STORES.items():
            volume = f'hawa-recovery-{self.nonce}-{kind}'
            docker('volume', 'create', '--label', self.label, '--label', 'com.docker.compose.project=hawa-chaos',
                   '--label', f'com.docker.compose.volume={logical}', volume)
            self.helper(volume, ['-xf', '-'], input_path=self.work/f'{kind}.restored.tar')
            copied = self.work/f'{kind}.check.tar'
            self.helper(volume, ['-cf', '-', '.'], output_path=copied, readonly=True)
            if archive_members(copied) != contents[kind]:
                raise DrillError('restored volume differs before startup')
            override['volumes'][logical] = {'name': volume}
        OVERRIDE.write_text(json.dumps(override, indent=2)+'\n')
        recovery_start = time.monotonic()
        print('Stores restored to fresh volumes; verifying before starting application writers.', flush=True)
        self.compose('up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate',
                     '--wait', '--wait-timeout', '120', 'postgres', 'restate')
        self.assert_stopped(('core', 'worker-blue'))
        if fingerprint(self.sql) != expected:
            raise DrillError('restored database data/RLS differs')
        blobs = json.loads(self.sql('SELECT json_agg(row_to_json(b)) FROM (SELECT sha256,size,media_type FROM hawa.blobs) b'))
        blob_count = verify_blobs(blobs, contents['blobs'])
        if self.sql("SELECT count(*) FROM hawa.blob_reference_hashes() AS h LEFT JOIN hawa.blobs b ON b.sha256=h WHERE b.sha256 IS NULL") != '0':
            raise DrillError('restored file reference lacks a registered blob')
        deadline = time.monotonic()+60
        while True:
            try:
                restored_pending = self.pending()
                if restored_pending == pending:
                    break
            except DrillError:
                pass
            if time.monotonic() > deadline:
                raise DrillError('pending delivery identity not restored')
            time.sleep(1)
        fake = json.loads(docker('inspect', 'hawa-chaos-fakes-1'))[0]
        if (fake['Id'] != self.identity['fakes']['Id'] or not fake['State']['Running'] or
            fake['State']['StartedAt'] != self.identity['fakes']['State']['StartedAt']):
            raise DrillError('external test service was replaced during recovery')
        receipt = {'status': 'coordinated_stores_restored_before_worker_admission', 'taskId': self.task,
          'capturedAt': facts['capturedAt'], 'images': facts['images'], 'archives': facts['archives'],
          'pendingDelivery': pending, 'tableCount': len(expected['tables']), 'policyCount': len(expected['policies']),
          'restoredVolumes': override['volumes'], 'allRowsAndPoliciesMatch': True, 'allStoreFilesMatch': True,
          'verifiedBlobCount': blob_count, 'missingBlobReferences': 0,
          'externalServiceSurvived': True, 'writersStoppedBeforeCaptureAndDuringValidation': True,
          'fsync': True, 'fullPageWrites': True, 'restoreValidationSeconds': round(time.monotonic()-recovery_start, 3),
          'applicationReplayProved': False, 'separateHostProved': False, 'productionChanged': False,
          'scriptSha256': sha256(Path(__file__))}
        shutil.rmtree(self.work)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--task-id', required=True)
    parser.add_argument('--started-after', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve().parent != RUN.resolve():
        raise DrillError('write the receipt only inside the candidate run directory')
    drill = CandidateRecovery(args.task_id, args.started_after)
    try:
        receipt = drill.execute()
    except BaseException:
        print(f'Recovery not admitted. No automatic restart; private artifacts: {drill.work}', flush=True)
        raise
    args.output.write_text(json.dumps(receipt, indent=2)+'\n')
    print('Coordinated stores verified; application replay remains the caller\'s next gate.', flush=True)


if __name__ == '__main__':
    main()
