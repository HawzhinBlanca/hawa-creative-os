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
    def test_invalid_caller_recovery_identity_is_refused_before_mutation(self):
        with patch('candidate_recovery.docker') as docker:
            for identity in ['../foreign','a'*15,'A'*16,'a'*17]:
                with self.assertRaisesRegex(DrillError,'recovery identity'):
                    CandidateRecovery('11111111-1111-4111-a111-111111111111',
                        '2026-09-26T00:00:00Z',recovery_id=identity)
            docker.assert_not_called()

    def synthetic_execute(self, directory, *, validation_failure=False, existing_recovery=False):
        """Real archives/crypto/private files; Docker and SQL are explicitly simulated."""
        root=Path(directory)
        recovery=CandidateRecovery('11111111-1111-4111-a111-111111111111', '2026-09-26T00:00:00Z',
            recovery_id='0123456789abcdef')
        payload=b'synthetic registered PDF'
        digest=hashlib.sha256(payload).hexdigest()
        volumes={}
        for kind in STORES:
            data=io.BytesIO()
            with tarfile.open(fileobj=data, mode='w') as archive:
                name=f'sha256/{digest[:2]}/{digest}.pdf' if kind=='blobs' else 'synthetic-state'
                member=tarfile.TarInfo(name); member.size=len(payload);member.mode=0o600
                archive.addfile(member,io.BytesIO(payload))
            volumes['source-'+kind]=data.getvalue()
        recovery.identity={service:{'Image':'sha256:'+'a'*64,'Mounts':[],'Id':service,
            'Created':'2026-09-27T00:00:00.000000Z','NetworkSettings':{'Networks':{'synthetic-internal':{}}},
            'State':{'Running':True,'StartedAt':'synthetic-start'},'Config':{'Cmd':['postgres'],
                'Env':['RESTATE_NODE_NAME=hawa-restate-chaos-1'],
                'Labels':{'com.docker.compose.project':'hawa-chaos','com.docker.compose.service':service}}}
            for service in ['postgres','restate','core','worker-blue','fakes']}
        for kind,(service,target,_) in STORES.items():
            recovery.identity[service]['Mounts'].append({'Type':'volume','Destination':target,'Name':'source-'+kind})
        def helper(volume,args,*,input_path=None,output_path=None,readonly=False):
            if input_path:volumes[volume]=input_path.read_bytes()
            if output_path:output_path.write_bytes(volumes[volume])
        def docker(*args,**kwargs):
            if args[0:2]==('network','inspect'):return json.dumps([{'Internal':True}])
            if args[0:2]==('volume','inspect'):return json.dumps([{'Labels':{'com.docker.compose.project':'hawa-chaos'}}])
            if args[0:2]==('volume','ls'):return 'hawa-recovery-'+recovery.nonce+'-postgres' if existing_recovery else ''
            if args[0]=='inspect' and '--format' in args:return 'false'
            if args[0]=='inspect':return json.dumps([recovery.identity[args[1].removeprefix('hawa-chaos-').removesuffix('-1')]])
            return ''
        def sql(query):
            if 'current_setting' in query:return 'on/on'
            if 'json_agg' in query:return json.dumps([{'sha256':digest,'size':len(payload),'media_type':'application/pdf'}])
            return '0'
        fingerprint={'tables':{'synthetic':{}},'policies':[{}]}
        restored={'tables':{'changed':{}},'policies':[]} if validation_failure else fingerprint
        self.enterContext(patch('candidate_recovery.RUN',root))
        self.enterContext(patch('candidate_recovery.OVERRIDE',root/'recovery.compose.json'))
        self.enterContext(patch.object(recovery,'inspect'))
        self.enterContext(patch.object(recovery,'helper',side_effect=helper))
        self.enterContext(patch.object(recovery,'sql',side_effect=sql))
        self.enterContext(patch.object(recovery,'pending',return_value=[{'id':'synthetic-invocation','pinned_deployment_id':'synthetic-deployment'}]))
        self.enterContext(patch('candidate_recovery.fingerprint',side_effect=[fingerprint,restored]))
        self.enterContext(patch('candidate_recovery.docker',side_effect=docker))
        compose=self.enterContext(patch.object(recovery,'compose'))
        return recovery,compose

    def test_reserved_recovery_identity_refuses_existing_volume_before_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            recovery,compose=self.synthetic_execute(directory,existing_recovery=True)
            with patch.object(recovery,'inspect',side_effect=lambda:CandidateRecovery.inspect(recovery)):
                with self.assertRaisesRegex(DrillError,'recovery identity already has volumes'):recovery.execute()
            self.assertIsNone(recovery.work)
            compose.assert_not_called()

    def test_success_cleanup_is_bound_to_this_restore_and_preserves_prior_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            prior=Path(directory)/'recovery-private-prior-failure';prior.mkdir()
            retained=prior/'synthetic-state';retained.write_bytes(b'prior failed restore')
            recovery,compose=self.synthetic_execute(directory)
            receipt=recovery.execute()
            self.assertFalse(recovery.work.exists())
            self.assertEqual(retained.read_bytes(),b'prior failed restore')
            self.assertEqual(receipt.get('recoveryId'),recovery.nonce)
            self.assertEqual(receipt.get('privateArtifactsCleanup'),{'removed':True,'scope':'this_recovery'})
            self.assertTrue(all(v['name'].startswith('hawa-recovery-'+recovery.nonce+'-') for v in receipt['restoredVolumes'].values()))
            self.assertTrue(receipt['allStoreFilesMatch'])
            self.assertFalse(receipt['applicationReplayProved'])
            self.assertEqual(compose.call_count,1)
            self.assertNotIn('core',compose.call_args.args)
            self.assertNotIn('worker-blue',compose.call_args.args)

    def test_failed_validation_retains_private_files_and_never_admits_writers(self):
        with tempfile.TemporaryDirectory() as directory:
            recovery,compose=self.synthetic_execute(directory,validation_failure=True)
            with self.assertRaisesRegex(DrillError,'database data/RLS differs'):recovery.execute()
            self.assertTrue((recovery.work/'key').is_file())
            self.assertTrue((recovery.work/'postgres.tar').is_file())
            self.assertEqual(compose.call_count,1)
            self.assertNotIn('core',compose.call_args.args)
            self.assertNotIn('worker-blue',compose.call_args.args)

    def test_cleanup_error_retains_files_without_emitting_success(self):
        with tempfile.TemporaryDirectory() as directory:
            recovery,_=self.synthetic_execute(directory)
            with patch('candidate_recovery.shutil.rmtree',side_effect=OSError('synthetic removal failure')):
                with self.assertRaisesRegex(OSError,'removal failure'):recovery.execute()
            self.assertTrue((recovery.work/'key').is_file())

    def test_cleanup_postcondition_refuses_a_directory_that_remains(self):
        with tempfile.TemporaryDirectory() as directory:
            recovery,_=self.synthetic_execute(directory)
            with patch('candidate_recovery.shutil.rmtree'):
                with self.assertRaisesRegex(DrillError,'private recovery artifacts remain'):recovery.execute()
            self.assertTrue((recovery.work/'key').is_file())

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
