#!/usr/bin/env python3
"""Copy the newest complete encrypted recovery set to a second place, verify it there, prune old sets.

ADR-141, plans/hosting section 6.1: the nightly archive must not live only on the host it protects.
Run by infra/backup/offsite_copy.sh, which holds the archive lock in shared mode for the whole run
(the nightly backup takes it exclusively, so a set is never read while it is being written or pruned).

A recovery set is what one night of nightly_backup.sh published in the archive:
  hawa_<S>.dump.enc, hawa_<S>.dump.enc.sha256   the database dump, encrypted, and its checksum
  hawa_<S>.blobs                               the file-store manifest (every file the dump needs)
  blobs/blobpack_<N>.tar.enc                   every pack that holds one of those files (blobs/index.tsv)
  hawa_<S>.restate.json, restate_<T>.json, restate_<T>.tar.enc
                                               the paired Restate copy, when the archive holds pairs
It is complete when every member is there and every hash agrees: the dump with its checksum, and for a
pair the authenticated pair and Restate manifests (restate_nightly.read_pair_metadata and
read_archive_metadata, which need the archive key but decrypt nothing). Only encrypted sets are copied.

At the destination each set also gets hawa_<S>.index.tsv (the index rows for its manifest: copy it to
blobs/index.tsv to restore from there) and, written last once every member is verified,
hawa_<S>.offsite.json, the receipt: a set without a receipt is not complete at the destination.

Destinations (HAWA_OFFSITE_DEST):
  /absolute/path          a mounted disk or directory; copied with a temporary name, then renamed, and
                          verified by reading every file back with SHA-256
  [user@]host:path        rsync over ssh (a Hetzner Storage Box: HAWA_OFFSITE_RSH="ssh -p 23 -i <key>");
                          verified by `rsync --checksum --dry-run`, which compares every file's content
                          on both sides and must report nothing to transfer
HAWA_OFFSITE_TRANSPORT=path|rsync overrides the choice (the tests run rsync against a local path).
HAWA_OFFSITE_KEEP (default 14) is how many sets the destination keeps; a pack goes when no kept
receipt lists it. Only names this script writes are ever deleted there.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from restate_nightly import BackupError, read_archive_metadata, read_pair_metadata  # noqa: E402

STAMP = r"[0-9]{8}T[0-9]{6}Z"
DUMP_NAME = re.compile(rf"^hawa_({STAMP})\.dump\.enc$")
RECEIPT_NAME = re.compile(rf"^hawa_({STAMP})\.offsite\.json$")
# Every name this script may write, and so the only names it may delete, at the destination.
OWNED = re.compile(rf"^(?:hawa_{STAMP}\.(?:dump\.enc|dump\.enc\.sha256|blobs|restate\.json|index\.tsv|offsite\.json)"
                   rf"|restate_{STAMP}\.(?:json|tar\.enc)|blobs/blobpack_{STAMP}\.tar\.enc)$")
PACK_NAME = re.compile(rf"^blobpack_{STAMP}\.tar\.enc$")
MANIFEST_LINE = re.compile(r"^sha256/[0-9a-f]{2}/[0-9a-f]{64}\.[a-z]+$")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@dataclass
class RecoverySet:
    stamp: str
    members: list[str]                 # paths relative to the archive
    index_rows: list[str]              # "<file>\t<pack>" for every file of the manifest
    paired: bool
    hashes: dict[str, str] = field(default_factory=dict)
    sizes: dict[str, int] = field(default_factory=dict)


class Incomplete(Exception):
    """This night's set cannot be copied; an older one may be."""


def load_index(archive: Path) -> dict[str, str]:
    index = archive / "blobs" / "index.tsv"
    rows: dict[str, str] = {}
    if not index.is_file():
        return rows
    for line in index.read_text().splitlines():
        if not line:
            continue
        path, _, pack = line.partition("\t")
        rows[path] = pack
    return rows


def check_set(archive: Path, stamp: str, key: Path | None, require_pair: bool, index: dict[str, str]) -> RecoverySet:
    dump = archive / f"hawa_{stamp}.dump.enc"
    checksum = archive / f"hawa_{stamp}.dump.enc.sha256"
    manifest = archive / f"hawa_{stamp}.blobs"
    for path in (dump, checksum, manifest):
        if not path.is_file() or path.is_symlink():
            raise Incomplete(f"{stamp}: {path.name} is missing")
    recorded = checksum.read_text().split()
    dump_sha = sha256(dump)
    if not recorded or recorded[0] != dump_sha:
        raise Incomplete(f"{stamp}: the dump does not match its checksum")
    members = [dump.name, checksum.name, manifest.name]
    pair = archive / f"hawa_{stamp}.restate.json"
    paired = pair.is_file()
    if require_pair and not paired:
        raise Incomplete(f"{stamp}: no paired Restate copy (the archive holds pairs)")
    if paired:
        if key is None or not key.is_file():
            raise Incomplete(f"{stamp}: the pair cannot be authenticated without HAWA_BACKUP_ARCHIVE_KEYFILE")
        try:
            facts = read_pair_metadata(pair, key)
            restate_manifest = archive / facts["restateManifestName"]
            if (facts["dumpSha256"] != dump_sha or sha256(manifest) != facts["blobManifestSha256"]
                    or not restate_manifest.is_file() or sha256(restate_manifest) != facts["restateManifestSha256"]):
                raise Incomplete(f"{stamp}: the pair does not match its dump, manifest or Restate copy")
            read_archive_metadata(restate_manifest, key)  # also checks the Restate ciphertext's hash
        except BackupError as exc:
            raise Incomplete(f"{stamp}: {exc}") from exc
        members += [pair.name, restate_manifest.name, restate_manifest.with_suffix(".tar.enc").name]
    rows: list[str] = []
    packs: set[str] = set()
    for line in manifest.read_text().splitlines():
        if not line:
            continue
        if not MANIFEST_LINE.fullmatch(line):
            raise Incomplete(f"{stamp}: the file manifest has a malformed line")
        pack = index.get(line)
        if pack is None:
            raise Incomplete(f"{stamp}: a file of the manifest is in no pack")
        if not PACK_NAME.fullmatch(pack):
            raise Incomplete(f"{stamp}: a file is in a pack that is not encrypted ({pack})")
        if not (archive / "blobs" / pack).is_file():
            raise Incomplete(f"{stamp}: pack {pack} is missing")
        rows.append(f"{line}\t{pack}")
        packs.add(pack)
    members += [f"blobs/{pack}" for pack in sorted(packs)]
    return RecoverySet(stamp, members, rows, paired)


def newest_complete(archive: Path, key: Path | None, restate_on: bool) -> tuple[RecoverySet, list[str]]:
    """The newest complete encrypted set, and why each newer night was passed over."""
    if not archive.is_dir():
        raise BackupError(f"no archive at {archive}")
    stamps = sorted((m.group(1) for p in archive.iterdir() if (m := DUMP_NAME.fullmatch(p.name))), reverse=True)
    if not stamps:
        plain = sorted(archive.glob("hawa_*.dump"))
        if plain:
            raise BackupError("the archive holds only unencrypted dumps; set HAWA_BACKUP_ARCHIVE_KEYFILE for the nightly backup first")
        raise BackupError("the archive holds no encrypted dump")
    require_pair = restate_on or any(archive.glob("hawa_*.restate.json"))
    index = load_index(archive)
    skipped: list[str] = []
    for stamp in stamps:
        try:
            return check_set(archive, stamp, key, require_pair, index), skipped
        except Incomplete as exc:
            skipped.append(str(exc))
    raise BackupError("no complete encrypted recovery set in the archive: " + "; ".join(skipped[:3]))


class Destination:
    label = ""
    method = ""

    def upload(self, source_root: Path, names: list[str]) -> None: raise NotImplementedError
    def verify(self, source_root: Path, names: list[str]) -> None: raise NotImplementedError
    def receipts(self) -> dict[str, dict]: raise NotImplementedError
    def delete(self, names: list[str]) -> None: raise NotImplementedError


class PathDestination(Destination):
    method = "sha256-readback"

    def __init__(self, root: Path):
        if not root.is_absolute():
            raise BackupError("a local off-site destination must be an absolute path")
        self.root = root
        self.label = str(root)

    def upload(self, source_root: Path, names: list[str]) -> None:
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in names:
            source, target = source_root / name, self.root / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if target.is_file() and not target.is_symlink() and target.stat().st_size == source.stat().st_size \
                    and sha256(target) == sha256(source):
                continue  # already there: a rerun copies nothing twice
            part = target.with_name(f".{target.name}.part")
            with source.open("rb") as src, part.open("wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
                dst.flush()
                os.fsync(dst.fileno())
            os.chmod(part, 0o600)
            os.replace(part, target)

    def verify(self, source_root: Path, names: list[str]) -> None:
        for name in names:
            target = self.root / name
            if not target.is_file() or target.is_symlink() or sha256(target) != sha256(source_root / name):
                raise BackupError(f"off-site copy of {name} differs from the archive")

    def receipts(self) -> dict[str, dict]:
        found: dict[str, dict] = {}
        if not self.root.is_dir():
            return found
        for path in self.root.iterdir():
            match = RECEIPT_NAME.fullmatch(path.name)
            if match:
                found[match.group(1)] = json.loads(path.read_text())
        return found

    def delete(self, names: list[str]) -> None:
        for name in names:
            (self.root / name).unlink(missing_ok=True)


class RsyncDestination(Destination):
    method = "rsync-checksum"

    def __init__(self, target: str, rsh: str | None):
        self.target = target.rstrip("/") + "/"
        self.label = target
        self.base = ["rsync"] + (["-e", rsh] if rsh else [])

    def _run(self, args: list[str], what: str) -> str:
        result = subprocess.run(self.base + args, capture_output=True, text=True, timeout=6 * 3600, check=False)
        if result.returncode:
            raise BackupError(f"rsync could not {what} (exit {result.returncode}): {result.stderr.strip()[-300:]}")
        return result.stdout

    @staticmethod
    def _list_file(names: list[str], work: Path) -> Path:
        path = work / "files"
        path.write_text("".join(f"{name}\n" for name in names))
        return path

    def upload(self, source_root: Path, names: list[str]) -> None:
        with tempfile.TemporaryDirectory(prefix="hawa-offsite-") as work:
            files = self._list_file(names, Path(work))
            self._run(["-a", "--chmod=D700,F600", "--partial-dir=.rsync-partial", f"--files-from={files}",
                       f"{source_root}/", self.target], "copy the set")

    def verify(self, source_root: Path, names: list[str]) -> None:
        with tempfile.TemporaryDirectory(prefix="hawa-offsite-") as work:
            files = self._list_file(names, Path(work))
            out = self._run(["-r", "--checksum", "--dry-run", "--itemize-changes", f"--files-from={files}",
                             f"{source_root}/", self.target], "verify the set")
        # A line starting with '.' is an attribute difference only; anything else would be sent again.
        differs = [line for line in out.splitlines() if line and not line.startswith(".")]
        if differs:
            raise BackupError(f"off-site copy differs from the archive: {differs[0][:120]}")

    def receipts(self) -> dict[str, dict]:
        found: dict[str, dict] = {}
        with tempfile.TemporaryDirectory(prefix="hawa-offsite-") as work:
            listing = subprocess.run(self.base + ["--list-only", self.target], capture_output=True, text=True,
                                     timeout=600, check=False)
            if listing.returncode:
                # A destination directory that does not exist yet holds no receipt.
                if "No such file" in listing.stderr or "change_dir" in listing.stderr:
                    return found
                raise BackupError(f"rsync could not list the destination (exit {listing.returncode}): {listing.stderr.strip()[-300:]}")
            names = [line.split()[-1] for line in listing.stdout.splitlines() if line.strip()]
            wanted = [name for name in names if RECEIPT_NAME.fullmatch(name)]
            if not wanted:
                return found
            files = self._list_file(wanted, Path(work))
            local = Path(work) / "receipts"
            local.mkdir()
            self._run(["-a", f"--files-from={files}", self.target, f"{local}/"], "read the receipts")
            for name in wanted:
                found[RECEIPT_NAME.fullmatch(name).group(1)] = json.loads((local / name).read_text())
        return found

    def delete(self, names: list[str]) -> None:
        if not names:
            return
        with tempfile.TemporaryDirectory(prefix="hawa-offsite-") as work:
            empty = Path(work) / "empty"
            (empty / "blobs").mkdir(parents=True)
            rules: list[str] = []
            if any(name.startswith("blobs/") for name in names):
                rules.append("--include=/blobs/")
            rules += [f"--include=/{name}" for name in names]
            self._run(["-r", "--delete", *rules, "--exclude=*", f"{empty}/", self.target], "delete expired sets")


def destination_from_env(environ: dict[str, str]) -> Destination:
    dest = environ.get("HAWA_OFFSITE_DEST", "").strip()
    if not dest:
        raise BackupError("HAWA_OFFSITE_DEST is not set")
    transport = environ.get("HAWA_OFFSITE_TRANSPORT", "auto").strip() or "auto"
    remote = ":" in dest.split("/", 1)[0]
    if transport not in ("auto", "path", "rsync"):
        raise BackupError("HAWA_OFFSITE_TRANSPORT must be auto, path or rsync")
    if transport == "rsync" or (transport == "auto" and remote):
        return RsyncDestination(dest, environ.get("HAWA_OFFSITE_RSH") or None)
    if remote:
        raise BackupError("a host:path destination needs the rsync transport")
    return PathDestination(Path(dest))


def run(archive: Path, key: Path | None, dest: Destination, keep: int, restate_on: bool,
        apply: bool = True, now: datetime | None = None) -> dict:
    if keep < 1 or keep > 365:
        raise BackupError("HAWA_OFFSITE_KEEP must be between 1 and 365")
    chosen, skipped = newest_complete(archive, key, restate_on)
    result = {"stamp": chosen.stamp, "paired": chosen.paired, "files": len(chosen.members) + 2,
              "skippedNewer": skipped, "dest": dest.label, "verified": dest.method}
    if not apply:
        result["status"] = "planned"
        result["members"] = chosen.members
        return result
    receipts = dest.receipts()
    with tempfile.TemporaryDirectory(prefix="hawa-offsite-set-") as work:
        stage = Path(work)
        index_name = f"hawa_{chosen.stamp}.index.tsv"
        (stage / index_name).write_text("".join(f"{row}\n" for row in chosen.index_rows))
        members = [*chosen.members, index_name]
        # The set's own files are read from the archive (under the shared lock they cannot change);
        # the two written here come from the staging directory.
        for name in chosen.members:
            chosen.hashes[name] = sha256(archive / name)
            chosen.sizes[name] = (archive / name).stat().st_size
        chosen.hashes[index_name] = sha256(stage / index_name)
        chosen.sizes[index_name] = (stage / index_name).stat().st_size
        receipt = {"schemaVersion": 1, "snapshotStamp": chosen.stamp, "paired": chosen.paired,
                   "copiedAt": (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "members": [{"path": name, "sha256": chosen.hashes[name], "bytes": chosen.sizes[name]} for name in members]}
        existing = receipts.get(chosen.stamp)
        same = isinstance(existing, dict) and existing.get("members") == receipt["members"]
        if same:
            # Already copied: verified again, and copied again if anything there changed since.
            try:
                dest.verify(archive, chosen.members)
                dest.verify(stage, [index_name])
            except BackupError:
                same = False
        if not same:
            dest.upload(archive, chosen.members)
            dest.upload(stage, [index_name])
            dest.verify(archive, chosen.members)
            dest.verify(stage, [index_name])
            receipt_name = f"hawa_{chosen.stamp}.offsite.json"
            (stage / receipt_name).write_text(json.dumps(receipt, indent=1) + "\n")
            dest.upload(stage, [receipt_name])
            dest.verify(stage, [receipt_name])
            receipts[chosen.stamp] = receipt
    result["status"] = "current" if same else "copied"
    result["bytes"] = sum(chosen.sizes.values())
    result.update(prune(dest, receipts, keep, chosen.stamp))
    return result


def prune(dest: Destination, receipts: dict[str, dict], keep: int, current: str) -> dict:
    """Keep the newest `keep` sets with a receipt (always the one just copied); delete the rest."""
    ordered = sorted(receipts, reverse=True)
    kept = set(ordered[:keep]) | {current}
    expired = [stamp for stamp in ordered if stamp not in kept]
    def names_of(stamp: str) -> list[str]:
        members = receipts[stamp].get("members", []) if isinstance(receipts[stamp], dict) else []
        return [m["path"] for m in members if isinstance(m, dict) and isinstance(m.get("path"), str)]
    needed_packs = {name for stamp in kept for name in names_of(stamp) if name.startswith("blobs/")}
    deletions: list[str] = []
    for stamp in sorted(expired):
        # The receipt goes first: a set cut short while being deleted is then no longer complete.
        deletions.append(f"hawa_{stamp}.offsite.json")
        deletions += [name for name in names_of(stamp) if not name.startswith("blobs/")]
        deletions += [name for name in names_of(stamp) if name.startswith("blobs/") and name not in needed_packs]
    unowned = [name for name in deletions if not OWNED.fullmatch(name)]
    if unowned:
        raise BackupError(f"an expired off-site receipt names a file this script does not own: {unowned[0][:80]}")
    ordered_unique = list(dict.fromkeys(deletions))
    dest.delete(ordered_unique)
    return {"keptSets": len(kept), "prunedSets": expired,
            "prunedPacks": sum(1 for name in ordered_unique if name.startswith("blobs/"))}


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="copy, verify and prune (default: show the plan)")
    args = parser.parse_args()
    environ = dict(os.environ)
    archive = Path(environ.get("HAWA_BACKUP_ARCHIVE_DEST") or str(Path.home() / ".hawa/snapshots_archive"))
    key_value = environ.get("HAWA_BACKUP_ARCHIVE_KEYFILE", "")
    key = Path(key_value) if key_value else None
    try:
        from archive_lock import inherited_lock
        if args.apply and not inherited_lock(archive, "shared"):
            raise BackupError("offsite_copy.py --apply must run under infra/backup/offsite_copy.sh (the archive lock)")
        keep_value = environ.get("HAWA_OFFSITE_KEEP", "14")
        if not re.fullmatch(r"[0-9]+", keep_value):
            raise BackupError("HAWA_OFFSITE_KEEP must be a whole number")
        result = run(archive, key, destination_from_env(environ), int(keep_value),
                     environ.get("HAWA_RESTATE_BACKUP_ENABLED", "off") == "on", apply=args.apply)
        print(json.dumps(result))
        return 0
    except (BackupError, OSError, ValueError) as exc:
        print(f"off-site copy refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
