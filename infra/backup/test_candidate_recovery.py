"""Refusal controls for coordinated capture; journal replay requires the real candidate drill."""
import hashlib
import io
import json
import secrets
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from candidate_recovery import CandidateRecovery, DrillError, PURPOSE, STORES, archive_members, verify_blobs, verify_manifest
from restate_nightly import metadata_mac, sha256


class CoordinatedRecoveryTest(unittest.TestCase):
    def test_source_project_refused_before_any_mutation(self):
        value = {'Config': {'Labels': {'com.docker.compose.project': 'hawa-production'}},
                 'Created': '2026-09-27T00:00:00.000000Z'}
        recovery = CandidateRecovery('11111111-1111-4111-a111-111111111111', '2026-09-26T00:00:00Z')
        with patch('candidate_recovery.docker', return_value=json.dumps([value])) as docker:
            with self.assertRaisesRegex(DrillError, 'identity refused'):
                recovery.execute()
        self.assertEqual(docker.call_count, 1)
        self.assertEqual(docker.call_args.args[0], 'inspect')
        self.assertIsNone(recovery.work)

    def test_running_writer_blocks_capture(self):
        recovery = CandidateRecovery('11111111-1111-4111-a111-111111111111', '2026-09-26T00:00:00Z')
        with patch('candidate_recovery.docker', return_value='true'):
            with self.assertRaisesRegex(DrillError, 'writer still running'):
                recovery.assert_stopped(('core', 'worker-blue'))

    def test_archive_refuses_traversal_links_and_duplicate_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'store.tar'
            for names, link in [(['../escaped'], False), (['/absolute'], False),
                                (['member'], True), (['member', './member'], False)]:
                with tarfile.open(path, 'w') as archive:
                    for name in names:
                        member = tarfile.TarInfo(name)
                        if link:
                            member.type = tarfile.SYMTYPE; member.linkname = '/etc/passwd'
                            archive.addfile(member)
                        else:
                            member.size = 3; archive.addfile(member, io.BytesIO(b'abc'))
                with self.assertRaises(DrillError): archive_members(path)

    def test_archive_identity_includes_bytes_ownership_and_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'store.tar'
            with tarfile.open(path, 'w') as archive:
                member = tarfile.TarInfo('./pgdata/PG_VERSION'); member.size=2
                member.uid=999; member.gid=999; member.mode=0o600
                archive.addfile(member, io.BytesIO(b'17'))
            self.assertEqual(archive_members(path), {'pgdata/PG_VERSION':
                [2, 0o600, 999, 999, hashlib.sha256(b'17').hexdigest()]})

    def test_manifest_refuses_wrong_key_changed_archive_and_incomplete_set(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); key=root/'key'; key.write_text(secrets.token_hex(32))
            facts={'archives':{}}
            for kind in STORES:
                path=root/f'{kind}.tar.enc'; path.write_bytes(secrets.token_bytes(32))
                facts['archives'][kind]={'filename':path.name,'ciphertextSha256':sha256(path)}
            facts['authenticator']=metadata_mac(facts,key,PURPOSE)
            verify_manifest(facts,key,root)
            wrong=root/'wrong'; wrong.write_text(secrets.token_hex(32))
            with self.assertRaisesRegex(DrillError,'authentication'): verify_manifest(facts,wrong,root)
            (root/'blobs.tar.enc').write_bytes(b'changed')
            with self.assertRaisesRegex(DrillError,'identity'): verify_manifest(facts,key,root)
            facts.pop('authenticator'); facts['archives'].pop('blobs')
            facts['authenticator']=metadata_mac(facts,key,PURPOSE)
            with self.assertRaisesRegex(DrillError,'incomplete'): verify_manifest(facts,key,root)

    def test_blob_validation_refuses_missing_wrong_size_or_wrong_bytes(self):
        digest=hashlib.sha256(b'pdf fixture').hexdigest()
        rows=[{'sha256':digest,'size':11,'media_type':'application/pdf'}]
        filename=f'sha256/{digest[:2]}/{digest}.pdf'
        self.assertEqual(verify_blobs(rows,{filename:[11,0o600,10001,10001,digest]}),1)
        for members in [{},{filename:[10,0o600,10001,10001,digest]},
                        {filename:[11,0o600,10001,10001,'changed']}]:
            with self.assertRaisesRegex(DrillError,'missing or corrupt'): verify_blobs(rows,members)

    def test_no_blob_or_unknown_media_cannot_qualify(self):
        with self.assertRaises(DrillError): verify_blobs([],{})
        with self.assertRaises(DrillError):
            verify_blobs([{'sha256':'a'*64,'size':1,'media_type':'application/unknown'}],{})


if __name__ == '__main__': unittest.main()
