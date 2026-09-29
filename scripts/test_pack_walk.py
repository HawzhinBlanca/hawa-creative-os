"""Regression checks for the specification scanner's inclusion boundary."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import validate_pack as validator


class PackWalkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root_patch = patch.object(validator, "ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def put(self, name):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture\n")
        return path

    def test_same_files_as_previous_walk(self):
        for name in (
            "README.md", "docs/nested/example.yaml", "docs/package.json",
            "docs/node_modules/still-included.md", "package.json",
            "config/private.yaml", "config/nested/value.example.yaml",
            "config/nested/value.example.json", "config/.env.example",
            ".env.local", ".env.example", "docs/.env/nested.md",
            "docs/.env.local", "docs/.env.example", "docs/cache.pyc",
            "docs/__pycache__/nested.md", "docs/.DS_Store/nested.md",
        ):
            self.put(name)
        for name in validator.IGNORED_TOP_LEVEL:
            self.put(name + "/nested/dependency.md")
        expected = {p for p in self.root.rglob("*")
                    if p.is_file() and not validator.should_skip(p)}
        self.assertEqual(set(validator.package_files()), expected)
        self.assertIn(self.root / "config/nested/value.example.yaml", expected)
        self.assertIn(self.root / "docs/node_modules/still-included.md", expected)

    def test_never_enters_excluded_subtrees(self):
        self.put("node_modules/deep/fixture.md")
        self.put(".worktrees/other/deep/fixture.md")
        kept = self.put("docs/kept.md")
        self.put("docs/__pycache__/deep/fixture.md")
        original = os.scandir

        def guarded(path):
            rel = Path(path).relative_to(self.root)
            if any(part in {"node_modules", ".worktrees", "__pycache__"} for part in rel.parts):
                raise AssertionError("entered an excluded subtree")
            return original(path)

        with patch.object(os, "scandir", guarded):
            self.assertEqual(validator.package_files(), [kept])

    def test_symlinks_match_previous_walk_without_recursion(self):
        kept = self.put("docs/kept.md")
        (self.root / "loop").symlink_to(self.root, target_is_directory=True)
        (self.root / "copy.md").symlink_to(kept)
        (self.root / "missing.md").symlink_to(self.root / "absent")
        expected = {p for p in self.root.rglob("*")
                    if p.is_file() and not validator.should_skip(p)}
        self.assertEqual(set(validator.package_files()), expected)

    def test_unreadable_included_directory_fails_closed(self):
        self.put("docs/kept.md")
        original = os.scandir

        def blocked(path):
            if Path(path) == self.root / "docs":
                raise PermissionError("fixture unreadable directory")
            return original(path)

        with patch.object(os, "scandir", blocked):
            with self.assertRaises(PermissionError):
                validator.package_files()


if __name__ == "__main__":
    unittest.main()
