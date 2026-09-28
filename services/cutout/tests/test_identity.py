"""The runtime identity the service reports with every answer (ADR-123). Model-free and free of the
inference dependencies: runs wherever Python runs."""
from __future__ import annotations

import hashlib
import os
import tempfile
import unittest

from hawa_cutout.identity import IMPLEMENTATION, code_sha256, runtime_identity


class RuntimeIdentity(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.root = self.dir.name
        for name, text in (('core.py', 'A = 1\n'), ('server.py', 'B = 2\n')):
            with open(os.path.join(self.root, name), 'w') as f:
                f.write(text)
        self.face = os.path.join(self.root, 'face.onnx')
        with open(self.face, 'wb') as f:
            f.write(b'synthetic face model')

    def tearDown(self) -> None:
        self.dir.cleanup()

    def test_code_hash_follows_the_source_bytes(self) -> None:
        first = code_sha256(self.root)
        self.assertEqual(code_sha256(self.root), first)
        with open(os.path.join(self.root, 'core.py'), 'w') as f:
            f.write('A = 3\n')
        changed = code_sha256(self.root)
        self.assertNotEqual(changed, first)
        with open(os.path.join(self.root, 'core.py'), 'w') as f:
            f.write('A = 1\n')
        self.assertEqual(code_sha256(self.root), first)

    def test_identity_names_face_model_packages_and_implementation(self) -> None:
        identity = runtime_identity(self.face, root=self.root, packages=('pip', 'hawa-no-such-package'))
        self.assertEqual(identity['implementation'], IMPLEMENTATION)
        self.assertEqual(identity['faceModelSha256'], hashlib.sha256(b'synthetic face model').hexdigest())
        self.assertEqual(identity['codeSha256'], code_sha256(self.root))
        self.assertIsInstance(identity['packages']['pip'], str)
        # An absent package is recorded as absent, not guessed.
        self.assertIsNone(identity['packages']['hawa-no-such-package'])
        self.assertRegex(identity['python'], r'^\d+\.\d+\.\d+')

    def test_missing_face_model_is_refused(self) -> None:
        with self.assertRaises(OSError):
            runtime_identity(os.path.join(self.root, 'absent.onnx'), root=self.root)

    def test_the_installed_package_hashes_its_own_source(self) -> None:
        self.assertRegex(code_sha256(), r'^[0-9a-f]{64}$')


if __name__ == '__main__':
    unittest.main()
