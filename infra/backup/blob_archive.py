#!/usr/bin/env python3
"""Verify content-addressed backup packs before publication or safe extraction (ADR-081)."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


class ArchiveError(RuntimeError):
    pass


FILE = re.compile(r"sha256/([0-9a-f]{2})/([0-9a-f]{64})\.[a-z]+")
PACK = re.compile(r"blobpack_[0-9]{8}T[0-9]{6}Z\.tar(?:\.enc)?")


def file_hash(name: str) -> str:
    match = FILE.fullmatch(name)
    if match is None or match[1] != match[2][:2]:
        raise ArchiveError("file archive contains an unsafe or invalid content-addressed path")
    return match[2]


def verify(archive: Path, manifest: Path, key: Path | None = None,
           destination: Path | None = None) -> dict:
    """Read every selected pack; optionally publish only the requested files after all pass."""
    required: set[str] = set()
    for name in manifest.read_text().splitlines():
        file_hash(name)
        if name in required:
            raise ArchiveError("file manifest contains duplicate paths")
        required.add(name)
    if destination is not None and (destination.exists() or destination.is_symlink()):
        raise ArchiveError("file extraction destination must not already exist")

    index = archive / 'blobs/index.tsv'
    mapping: dict[str, str] = {}
    if required and (not index.is_file() or index.is_symlink()):
        raise ArchiveError("file manifest needs a regular pack index")
    if required:
        for line in index.read_text().splitlines():
            fields = line.split('\t')
            if len(fields) != 2:
                raise ArchiveError("file pack index has a malformed row")
            name, pack = fields
            file_hash(name)
            if not PACK.fullmatch(pack) or name in mapping:
                raise ArchiveError("file pack index contains an invalid pack or duplicate mapping")
            mapping[name] = pack
    if required - mapping.keys():
        raise ArchiveError("file manifest has files in no indexed pack")
    packs = sorted({mapping[name] for name in required})
    found: set[str] = set()
    verified_files = 0
    # The destination's parent is a private restore workspace. It must already exist;
    # publish by rename on the same filesystem, with no archive-directed extraction.
    parent = destination.parent if destination is not None else None
    with tempfile.TemporaryDirectory(prefix='hawa-blob-archive-', dir=parent) as tmp:
        work = Path(tmp)
        staged = work / 'files'
        staged.mkdir(mode=0o700)
        for pack in packs:
            source = archive / 'blobs' / pack
            if not source.is_file() or source.is_symlink():
                raise ArchiveError(f"pack {pack} is missing from the archive or is not a regular file")
            plain = source
            if pack.endswith('.enc'):
                lines = key.read_bytes().splitlines() if key is not None and key.is_file() else []
                if not lines or not lines[0]:
                    raise ArchiveError("encrypted file pack needs a readable nonempty key")
                plain = work / 'pack.tar'
                try:
                    result = subprocess.run(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '100000',
                                             '-in', str(source), '-out', str(plain), '-pass', f'file:{key}'],
                                            capture_output=True, timeout=3600, check=False)
                except subprocess.TimeoutExpired as exc:
                    raise ArchiveError("file pack decryption timed out") from exc
                if result.returncode:
                    raise ArchiveError(f"pack {pack} does not decrypt")
            names: set[str] = set()
            try:
                with tarfile.open(plain, 'r:') as tar:
                    for item in tar:
                        name = item.name.removeprefix('./')
                        if name in ('', '.') and item.isdir():
                            continue
                        if name in names:
                            raise ArchiveError("file pack contains duplicate paths or aliases")
                        names.add(name)
                        if item.isdir():
                            if name != 'sha256' and not re.fullmatch(r'sha256/[0-9a-f]{2}', name):
                                raise ArchiveError("file pack contains an unsafe directory")
                            continue
                        if item.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or item.sparse is not None:
                            raise ArchiveError("file pack contains a link or special member")
                        expected = file_hash(name)
                        wanted = name in required
                        if wanted and (mapping[name] != pack or name in found):
                            raise ArchiveError("file pack membership differs from its index")
                        stream = tar.extractfile(item)
                        if stream is None:
                            raise ArchiveError("file pack member cannot be read")
                        output = None
                        try:
                            if destination is not None and wanted:
                                target = staged / name
                                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                                output = target.open('xb')
                                os.chmod(target, 0o600)
                            digest = hashlib.sha256()
                            with stream:
                                for block in iter(lambda: stream.read(1024 * 1024), b''):
                                    digest.update(block)
                                    if output is not None:
                                        output.write(block)
                        finally:
                            if output is not None:
                                output.close()
                        if digest.hexdigest() != expected:
                            raise ArchiveError(f"pack {pack} has file bytes that do not match their content hash")
                        verified_files += 1
                        if wanted:
                            found.add(name)
            except (tarfile.TarError, EOFError) as exc:
                raise ArchiveError(f"pack {pack} is not a readable file archive") from exc
            finally:
                if plain != source:
                    plain.unlink(missing_ok=True)
        if found != required:
            raise ArchiveError("indexed file pack is missing a required member")
        if destination is not None:
            if destination.exists() or destination.is_symlink():
                raise ArchiveError("file extraction destination appeared during verification")
            os.rename(staged, destination)
    return {'status': 'verified_blob_archive', 'requiredFiles': len(required), 'verifiedPacks': len(packs),
            'verifiedPackFiles': verified_files, 'extractedFiles': len(found) if destination is not None else 0}


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    key_name = os.environ.get('HAWA_BACKUP_ARCHIVE_KEYFILE')
    try:
        print(json.dumps(verify(args.archive, args.manifest, Path(key_name) if key_name else None, args.destination)))
        return 0
    except (ArchiveError, OSError, UnicodeError) as exc:
        # Archive paths and parser payloads may be hostile; emit only controlled errors.
        detail = str(exc) if isinstance(exc, ArchiveError) else 'archive or workspace could not be read or written'
        print(f'File archive verification refused: {detail}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
