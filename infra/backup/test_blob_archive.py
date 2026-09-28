"""Exercise actual encrypted packs and hostile members; no Docker or live archives."""
import hashlib
import io
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

from blob_archive import ArchiveError, verify


class BlobArchiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.archive = self.root / 'archive'
        (self.archive / 'blobs').mkdir(parents=True)
        self.index = self.archive / 'blobs/index.tsv'
        self.manifest = self.archive / 'night.blobs'
        self.key = self.root / 'key'
        self.key.write_bytes(os.urandom(24).hex().encode())
        self.destination = self.root / 'restored'

    @staticmethod
    def name(data):
        digest = hashlib.sha256(data).hexdigest()
        return f'sha256/{digest[:2]}/{digest}.png'

    def pack(self, entries, *, encrypted=True, stamp='20260927T100000Z'):
        plain = self.archive / 'blobs' / f'blobpack_{stamp}.tar'
        with tarfile.open(plain, 'w') as tar:
            for name, payload in entries:
                item = tarfile.TarInfo(name)
                if isinstance(payload, bytes):
                    item.size = len(payload)
                    tar.addfile(item, io.BytesIO(payload))
                else:
                    item.type = payload
                    item.linkname = '../../outside'
                    tar.addfile(item)
        if not encrypted:
            return plain
        target = plain.with_suffix('.tar.enc')
        subprocess.run(['openssl','enc','-aes-256-cbc','-pbkdf2','-iter','100000','-salt',
                        '-in',str(plain),'-out',str(target),'-pass',f'file:{self.key}'],check=True,capture_output=True)
        plain.unlink()
        return target

    def fixture(self, *, encrypted=True):
        one, extra = b'wanted exact original bytes', b'older unused file in retained pack'
        name, other = self.name(one), self.name(extra)
        pack = self.pack([(name,one),(other,extra)], encrypted=encrypted)
        self.index.write_text(f'{name}\t{pack.name}\n{other}\t{pack.name}\n')
        self.manifest.write_text(name+'\n')
        return name, one, pack

    def test_encrypted_round_trip_extracts_only_required_files(self):
        name, data, _ = self.fixture()
        result = verify(self.archive,self.manifest,self.key,self.destination)
        self.assertEqual(result,dict(status='verified_blob_archive',requiredFiles=1,verifiedPacks=1,verifiedPackFiles=2,extractedFiles=1))
        self.assertEqual((self.destination/name).read_bytes(),data)
        self.assertEqual((self.destination/name).stat().st_mode & 0o777,0o600)
        self.assertEqual(len(list(self.destination.rglob('*.png'))),1)

    def test_plaintext_local_compatibility(self):
        self.fixture(encrypted=False)
        self.assertEqual(verify(self.archive,self.manifest)['verifiedPackFiles'],2)

    def test_wrong_key_and_damaged_ciphertext_preserve_archive_and_publish_nothing(self):
        _,_,pack = self.fixture()
        original = pack.read_bytes()
        wrong = self.root/'wrong';wrong.write_bytes(b'wrong local fixture key')
        for key in [wrong,self.key]:
            if key == self.key: pack.write_bytes(b'damaged archive')
            with self.assertRaisesRegex(ArchiveError,'does not decrypt'):
                verify(self.archive,self.manifest,key,self.destination)
            self.assertFalse(self.destination.exists())
            self.assertTrue(pack.exists())
        self.assertNotEqual(pack.read_bytes(),original)
        self.assertEqual(list(self.root.glob('hawa-blob-archive-*')),[])

    def test_missing_pack_and_incomplete_or_duplicate_index(self):
        name,_,pack = self.fixture()
        index = self.index.read_text()
        for value in ['', index+f'{name}\t{pack.name}\n',f'{name}\t../../outside\n']:
            self.index.write_text(value)
            with self.assertRaises(ArchiveError): verify(self.archive,self.manifest,self.key)
        self.index.write_text(index);pack.unlink()
        with self.assertRaisesRegex(ArchiveError,'is missing'): verify(self.archive,self.manifest,self.key)

    def test_hash_mismatch_or_missing_indexed_member_is_refused(self):
        name,data,_=self.fixture(encrypted=False)
        for entries, message in [([(name,b'changed')],'content hash'),([(self.name(b'other'),b'other')],'missing a required')]:
            self.pack(entries,encrypted=False)
            with self.assertRaisesRegex(ArchiveError,message): verify(self.archive,self.manifest,None,self.destination)
            self.assertFalse(self.destination.exists())

    def test_unsafe_archive_members_and_duplicate_aliases_never_escape(self):
        name,data,_=self.fixture(encrypted=False)
        for entry in [('../outside',b'x'),('/outside',b'x'),('sha256/../outside',b'x'),
                      ('escape',tarfile.SYMTYPE),('escape',tarfile.LNKTYPE),('escape',tarfile.FIFOTYPE),
                      ('../outside',tarfile.DIRTYPE),('./'+name,data)]:
            with self.subTest(entry=entry[0]):
                self.pack([(name,data),entry],encrypted=False)
                with self.assertRaises(ArchiveError): verify(self.archive,self.manifest,None,self.destination)
                self.assertFalse(self.destination.exists())
                self.assertFalse((self.root/'outside').exists())

    def test_manifest_paths_and_duplicate_members_are_refused(self):
        name,_,_=self.fixture()
        for text in ['../outside\n',name+'\n'+name+'\n',name.replace('/'+name.split('/')[1]+'/', '/zz/')+'\n']:
            self.manifest.write_text(text)
            with self.assertRaises(ArchiveError): verify(self.archive,self.manifest,self.key)

    def test_existing_destination_is_preserved(self):
        self.fixture();self.destination.mkdir();(self.destination/'sentinel').write_text('preserve')
        with self.assertRaisesRegex(ArchiveError,'must not already exist'):
            verify(self.archive,self.manifest,self.key,self.destination)
        self.assertEqual((self.destination/'sentinel').read_text(),'preserve')

    def test_later_pack_failure_does_not_publish_partial_restoration(self):
        self.fixture(encrypted=False)
        data=b'later required file';name=self.name(data)
        pack=self.pack([(name,b'damaged')],encrypted=False,stamp='20260927T110000Z')
        self.index.write_text(self.index.read_text()+f'{name}\t{pack.name}\n')
        self.manifest.write_text(self.manifest.read_text()+name+'\n')
        with self.assertRaisesRegex(ArchiveError,'content hash'):
            verify(self.archive,self.manifest,None,self.destination)
        self.assertFalse(self.destination.exists())
        self.assertEqual(list(self.root.glob('hawa-blob-archive-*')),[])

    def test_empty_store_needs_no_index_or_packs(self):
        self.manifest.write_text('')
        result=verify(self.archive,self.manifest,None,self.destination)
        self.assertEqual(result['requiredFiles'],0)
        self.assertEqual(list(self.destination.iterdir()),[])


if __name__=='__main__': unittest.main()
