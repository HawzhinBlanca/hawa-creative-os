"""Safety boundaries for the PITR drill; physical/WAL correctness requires its real Docker run."""
import json
import subprocess
import unittest
from unittest.mock import patch

from drill_postgres_pitr import Drill, DrillError, SOURCE, config, run, key_metadata_refused

IMAGE='sha256:'+'e'*64

class PitrSafety(unittest.TestCase):
    def test_mutable_image_refused_before_docker(self):
        with patch('drill_postgres_pitr.subprocess.run') as call:
            with self.assertRaises(DrillError): Drill('pgvector/pgvector:pg17')
            call.assert_not_called()

    def test_source_project_refused_before_any_resource_creation(self):
        drill=Drill(IMAGE)
        with patch.object(drill,'docker',return_value=json.dumps([{'Config':{'Labels':{'com.docker.compose.project':'hawa-production'}}}])) as call:
            with self.assertRaisesRegex(DrillError,'not the isolated candidate'): drill.execute()
            self.assertEqual(call.call_args_list[0].args,('inspect',SOURCE))
            self.assertEqual(call.call_count,1)

    def test_ready_waits_until_target_recovery_has_promoted(self):
        drill=Drill(IMAGE)
        with patch.object(drill,'sql',side_effect=[DrillError('starting'),'f','t']) as sql, \
          patch('drill_postgres_pitr.time.sleep'):
            drill.ready('disposable')
        self.assertEqual(sql.call_count,3)
        self.assertTrue(all(call.args[1]=='SELECT NOT pg_is_in_recovery()' for call in sql.call_args_list))

    def test_key_configuration_rejects_injected_sections(self):
        with self.assertRaises(DrillError): config('valid\nrepo1-cipher-type=none')

    def test_key_is_transferred_by_stdin_not_docker_arguments(self):
        drill=Drill(IMAGE); key='a'*64
        with patch.object(drill,'docker',return_value='unused') as call:
            drill.config_volume(key)
            args=call.call_args
            self.assertNotIn(key,' '.join(args.args))
            self.assertIn(key,args.kwargs['data'].decode())
            self.assertIn('--network',args.args)
            self.assertIn('none',args.args)

    def test_cleanup_finds_resources_created_before_cli_timeout(self):
        drill=Drill(IMAGE); calls=[]
        def docker(*args):
            calls.append(args)
            if args[:2]==('ps','-aq'): return 'partial-container'
            if args[:3]==('volume','ls','-q'): return 'partial-volume'
            return ''
        with patch.object(drill,'docker',side_effect=docker): drill.cleanup()
        self.assertIn(('rm','-f','partial-container'),calls)
        self.assertIn(('volume','rm','partial-volume'),calls)
        for args in calls:
            if '--filter' in args: self.assertIn('label='+drill.label,args)

    def test_cleanup_error_cannot_return_a_success(self):
        drill=Drill(IMAGE)
        def docker(*args):
            if args[:2]==('ps','-aq'): return 'partial-container'
            if args[:2]==('rm','-f'): raise DrillError('container remains')
            return ''
        with patch.object(drill,'docker',side_effect=docker):
            with self.assertRaisesRegex(DrillError,'cleanup failed'): drill.cleanup()

    def test_pgbackrest_stdout_errors_survive_without_logging_inputs(self):
        process=subprocess.CompletedProcess(['docker'],75,b'INFO: command begin\nERROR: unable to restore\nHINT: check target\n',b'')
        with patch('drill_postgres_pitr.subprocess.run',return_value=process):
            with self.assertRaisesRegex(DrillError,'ERROR: unable to restore') as caught:
                run(['docker'],data=b'private input')
            self.assertNotIn('private input',str(caught.exception))
            self.assertNotIn('command begin',str(caught.exception))

    def test_key_refusal_requires_backup_metadata_crypto_or_format_error(self):
        for kind in ['CryptoError','FormatError']:
            self.assertTrue(key_metadata_refused(DrillError(
              f"WARN: repo1: [{kind}] unable to load info file '/var/lib/pgbackrest/backup/hawa/backup.info'")))
        for message in ['ERROR: backup set not valid', 'ERROR: unable to decrypt unrelated file',
          "WARN: repo1: [FileOpenError] unable to load info file '/var/lib/pgbackrest/backup/hawa/backup.info'"]:
            self.assertFalse(key_metadata_refused(DrillError(message)))

    def test_wrong_key_parser_payload_is_not_logged(self):
        process=subprocess.CompletedProcess(['docker'],75,
          b"WARN: repo1: [FormatError] unable to load info file '/var/lib/pgbackrest/backup/hawa/backup.info'\n"
          b'   FormatError: key/value outside section: binary-private-fragment\nERROR: invalid backup\n',b'')
        with patch('drill_postgres_pitr.subprocess.run',return_value=process):
            with self.assertRaises(DrillError) as caught: run(['docker'])
            self.assertTrue(key_metadata_refused(caught.exception))
            self.assertNotIn('binary-private-fragment',str(caught.exception))

if __name__=='__main__': unittest.main()
