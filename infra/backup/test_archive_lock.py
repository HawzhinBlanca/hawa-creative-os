import fcntl
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT=Path(__file__).with_name('archive_lock.py')


class ArchiveLockTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.archive=self.root/'archive';self.archive.mkdir()
        self.lock=self.archive/'.restate-backup.lock';self.lock.touch()
        self.env={k:v for k,v in os.environ.items() if not k.startswith('HAWA_ARCHIVE_LOCK_')}

    def run_lock(self,mode='exclusive',body=None,env=None):
        command=[sys.executable,'-c',body or 'raise SystemExit(0)']
        return subprocess.run([sys.executable,str(SCRIPT),'--archive',str(self.archive),'--mode',mode,'--',*command],
                              env=env or self.env,capture_output=True,text=True,timeout=15)

    def test_busy_lock_prevents_the_command_from_running(self):
        marker=self.root/'called'
        with self.lock.open('r+') as fd:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            for mode in ['shared','exclusive']:
                result=self.run_lock(mode,f'from pathlib import Path;Path({str(marker)!r}).touch()')
                self.assertEqual(result.returncode,1)
                self.assertFalse(marker.exists())

    def test_inherited_descriptor_covers_bash_children_and_blocks_mutation(self):
        body=f'''import subprocess,sys,os
subprocess.run(['bash','-c','exec "$@"','lock-check',sys.executable,{str(SCRIPT)!r},'--archive',{str(self.archive)!r},'--mode','exclusive','--check'],check=True,pass_fds=(int(os.environ['HAWA_ARCHIVE_LOCK_FD']),))
env={{k:v for k,v in os.environ.items() if not k.startswith('HAWA_ARCHIVE_LOCK_')}}
r=subprocess.run([sys.executable,{str(SCRIPT)!r},'--archive',{str(self.archive)!r},'--mode','exclusive','--',sys.executable,'-c','raise SystemExit(0)'],env=env,capture_output=True)
assert r.returncode==1
'''
        self.assertEqual(self.run_lock(body=body).returncode,0)
        self.assertEqual(self.run_lock().returncode,0)  # previous command released it

    def test_shared_readers_coexist_but_cannot_become_a_writer(self):
        body=f'''import subprocess,sys
r=subprocess.run([sys.executable,{str(SCRIPT)!r},'--archive',{str(self.archive)!r},'--mode','exclusive','--check'],capture_output=True,pass_fds=(int(__import__('os').environ['HAWA_ARCHIVE_LOCK_FD']),))
assert r.returncode==1
'''
        with self.lock.open('r+') as fd:
            fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
            self.assertEqual(self.run_lock('shared',body).returncode,0)
            self.assertEqual(self.run_lock('exclusive').returncode,1)

    def test_check_refuses_a_forged_marker_or_another_directory(self):
        env={**self.env,'HAWA_ARCHIVE_LOCK_FD':'99999','HAWA_ARCHIVE_LOCK_MODE':'exclusive'}
        result=subprocess.run([sys.executable,str(SCRIPT),'--archive',str(self.archive),'--mode','exclusive','--check'],env=env,capture_output=True)
        self.assertEqual(result.returncode,1)
        other=self.root/'other';other.mkdir();(other/'.restate-backup.lock').touch()
        body=f'''import subprocess,sys,os
r=subprocess.run([sys.executable,{str(SCRIPT)!r},'--archive',{str(other)!r},'--mode','exclusive','--check'],capture_output=True,pass_fds=(int(os.environ['HAWA_ARCHIVE_LOCK_FD']),))
assert r.returncode==1
'''
        self.assertEqual(self.run_lock(body=body).returncode,0)

    def test_failed_or_killed_command_releases_lock_and_symlink_is_refused(self):
        self.assertEqual(self.run_lock(body='raise SystemExit(7)').returncode,7)
        self.assertLess(self.run_lock(body='import os,signal;os.kill(os.getpid(),signal.SIGKILL)').returncode,0)
        self.assertEqual(self.run_lock().returncode,0)
        self.lock.unlink();target=self.root/'outside';target.touch();self.lock.symlink_to(target)
        self.assertEqual(self.run_lock().returncode,1)


if __name__=='__main__':unittest.main()
