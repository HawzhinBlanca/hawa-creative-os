#!/usr/bin/env python3
"""Bounded, fail-closed retention for opted-in paired Restate recovery sets (ADR-056)."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from restate_nightly import BackupError, read_archive_metadata, read_pair_metadata, sha256


PAIR_NAME = re.compile(r"^hawa_([0-9]{8}T[0-9]{6}Z)\.restate\.json$")
DUMP_NAME = re.compile(r"^hawa_([0-9]{8}T[0-9]{6}Z)\.dump\.enc$")
RESTATE_NAME = re.compile(r"^restate_[0-9]{8}T[0-9]{6}Z\.json$")
RESTATE_TAR_NAME = re.compile(r"^restate_[0-9]{8}T[0-9]{6}Z\.tar\.enc$")
PART_NAME = re.compile(r"^(?:restate_[0-9]{8}T[0-9]{6}Z\.(?:json|tar\.enc)|hawa_[0-9]{8}T[0-9]{6}Z\.restate\.json)\.part$")


def stamp_time(stamp: str) -> datetime:
    try:
        return datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise BackupError(f"invalid archive timestamp: {stamp}") from exc


@dataclass(frozen=True)
class PairRecord:
    stamp: str
    pair: Path
    dump: Path
    checksum: Path
    blobs: Path
    restate_manifest: Path
    restate_archive: Path
    dump_sha256: str
    blobs_sha256: str
    restate_manifest_sha256: str
    captured_at: str

    @property
    def complete(self) -> bool:
        return all(path.is_file() for path in (self.dump, self.checksum, self.blobs,
                                               self.restate_manifest, self.restate_archive))

    def verify_anchor(self, key_file: Path) -> None:
        """Check newest retained set before older recovery data can be deleted."""
        try:
            recorded_checksum = self.checksum.read_text().split()
        except UnicodeError as exc:
            raise BackupError(f"newest paired checksum is unreadable: {self.stamp}") from exc
        if (sha256(self.dump) != self.dump_sha256 or
                recorded_checksum != [self.dump_sha256] or
                sha256(self.blobs) != self.blobs_sha256 or
                sha256(self.restate_manifest) != self.restate_manifest_sha256):
            raise BackupError(f"newest paired recovery set changed: {self.stamp}")
        restate = read_archive_metadata(self.restate_manifest, key_file)
        if restate.get("capturedAt") != self.captured_at:
            raise BackupError(f"newest paired Restate capture changed: {self.stamp}")


@dataclass(frozen=True)
class RetentionPlan:
    keep_paired: tuple[str, ...]
    prune_paired: tuple[str, ...]
    keep_unpaired: tuple[str, ...]
    prune_unpaired: tuple[str, ...]
    unpaired_restate_count: int
    unpaired_restate_bytes: int
    stale_part_count: int
    deletions: tuple["Deletion", ...]

    def receipt(self, applied: bool) -> dict:
        return {"status": "pruned" if applied else "planned", "keepPaired": self.keep_paired,
                "prunePaired": self.prune_paired, "keepUnpairedDumps": self.keep_unpaired,
                "pruneUnpairedDumps": self.prune_unpaired,
                "unpairedRestateArchives": self.unpaired_restate_count,
                "unpairedRestateBytes": self.unpaired_restate_bytes,
                "stalePartialFiles": self.stale_part_count,
                "delete": [item.path.name for item in self.deletions]}


def fingerprint(path: Path) -> tuple[int, int, int, int, int] | None:
    try:
        stat = path.lstat()
    except FileNotFoundError:
        return None
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


@dataclass(frozen=True)
class Deletion:
    path: Path
    expected: tuple[int, int, int, int, int] | None

    def check(self) -> None:
        if fingerprint(self.path) != self.expected:
            raise BackupError(f"archive changed since retention plan: {self.path.name}")


def plan_retention(archive_dir: Path, key_file: Path, keep: int,
                   now: datetime | None = None, min_age: timedelta = timedelta(hours=24)) -> RetentionPlan:
    if keep < 1 or keep > 365:
        raise BackupError("paired archive retention must keep between 1 and 365 sets")
    if min_age < timedelta(0):
        raise BackupError("paired archive minimum age cannot be negative")
    if not archive_dir.is_dir() or not key_file.is_file():
        raise BackupError("paired archive directory and encryption key are required")
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise BackupError("retention clock must be timezone-aware")

    pairs: list[PairRecord] = []
    restate_owners: set[str] = set()
    for pair in sorted(archive_dir.glob("hawa_*.restate.json")):
        match = PAIR_NAME.fullmatch(pair.name)
        if not match:
            raise BackupError(f"malformed paired recovery-set name: {pair.name}")
        facts = read_pair_metadata(pair, key_file)
        stamp = match.group(1)
        stamp_time(stamp)
        restate_name = facts["restateManifestName"]
        if restate_name in restate_owners:
            raise BackupError("two paired recovery sets claim one Restate archive")
        restate_owners.add(restate_name)
        restate_manifest = archive_dir / restate_name
        pairs.append(PairRecord(stamp, pair, archive_dir / facts["dumpName"],
                                archive_dir / f"{facts['dumpName']}.sha256",
                                archive_dir / facts["blobManifestName"], restate_manifest,
                                restate_manifest.with_suffix(".tar.enc"), facts["dumpSha256"],
                                facts["blobManifestSha256"], facts["restateManifestSha256"],
                                facts["restateCapturedAt"]))

    complete = sorted((pair for pair in pairs if pair.complete), key=lambda pair: pair.stamp, reverse=True)
    if pairs and max(pairs, key=lambda pair: pair.stamp).complete is False:
        raise BackupError("newest paired recovery set is incomplete")
    if complete:
        complete[0].verify_anchor(key_file)
    protected = {pair.stamp for pair in complete[:keep]}
    def old_enough(stamp: str) -> bool:
        return now - stamp_time(stamp) >= min_age

    expired_pairs: list[PairRecord] = []
    for pair in pairs:
        if pair.stamp in protected or not old_enough(pair.stamp):
            if not pair.complete and pair.stamp in protected:
                raise BackupError(f"protected paired set is incomplete: {pair.stamp}")
            continue
        newer_complete = sum(candidate.stamp > pair.stamp for candidate in complete)
        if newer_complete >= keep:
            expired_pairs.append(pair)
        elif not pair.complete:
            raise BackupError(f"incomplete paired set needs operator review: {pair.stamp}")

    expired_stamps = {pair.stamp for pair in expired_pairs}
    dumps: list[tuple[str, Path]] = []
    paired_stamps = {pair.stamp for pair in pairs}
    for dump in archive_dir.glob("hawa_*.dump.enc"):
        match = DUMP_NAME.fullmatch(dump.name)
        if not match:
            raise BackupError(f"malformed encrypted dump name: {dump.name}")
        stamp = match.group(1)
        stamp_time(stamp)
        if stamp not in paired_stamps:
            dumps.append((stamp, dump))
    dumps.sort(reverse=True)
    reserve = keep if len(complete) < keep else 1
    protected_unpaired = {stamp for stamp, _ in dumps[:reserve]}
    expired_unpaired = [(stamp, dump) for stamp, dump in dumps
                        if stamp not in protected_unpaired and old_enough(stamp)]
    expired_unpaired.sort()

    deletions: list[Path] = []
    for pair in sorted(expired_pairs, key=lambda item: item.stamp):
        # Pair is last: a crash leaves authenticated metadata for the next run to finish safely.
        deletions.extend((pair.checksum, pair.dump, pair.restate_archive, pair.restate_manifest, pair.pair))
    for _, dump in expired_unpaired:
        deletions.extend((dump.with_name(f"{dump.name}.sha256"), dump))

    archive_names: set[str] = set()
    for path in archive_dir.glob("restate_*.json"):
        if not RESTATE_NAME.fullmatch(path.name):
            raise BackupError(f"malformed Restate archive manifest name: {path.name}")
        archive_names.add(path.name)
    for path in archive_dir.glob("restate_*.tar.enc"):
        if not RESTATE_TAR_NAME.fullmatch(path.name):
            raise BackupError(f"malformed Restate archive ciphertext name: {path.name}")
        archive_names.add(path.name.replace(".tar.enc", ".json"))
    orphans = sorted(archive_names - restate_owners)
    orphan_bytes = sum((archive_dir / name).with_suffix(".tar.enc").stat().st_size for name in orphans
                       if (archive_dir / name).with_suffix(".tar.enc").is_file())
    stale_parts: list[Path] = []
    for path in archive_dir.iterdir():
        if PART_NAME.fullmatch(path.name) and now - datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) >= min_age:
            stale_parts.append(path)
    deletions.extend(sorted(stale_parts))
    return RetentionPlan(tuple(pair.stamp for pair in complete if pair.stamp not in expired_stamps),
                         tuple(pair.stamp for pair in sorted(expired_pairs, key=lambda item: item.stamp)),
                         tuple(stamp for stamp, _ in dumps if stamp not in {item[0] for item in expired_unpaired}),
                         tuple(stamp for stamp, _ in expired_unpaired), len(orphans), orphan_bytes,
                         len(stale_parts),
                         tuple(Deletion(path, fingerprint(path)) for path in deletions))


def execute_plan(plan: RetentionPlan) -> None:
    # Refuse a changed target before the first delete, then again at each side-effect boundary.
    for item in plan.deletions:
        item.check()
    for item in plan.deletions:
        item.check()
        item.path.unlink(missing_ok=True)


def apply_retention(archive_dir: Path, key_file: Path, keep: int,
                    now: datetime | None = None, min_age: timedelta = timedelta(hours=24)) -> RetentionPlan:
    if not archive_dir.is_dir():
        raise BackupError("paired archive directory is missing")
    lock_path = archive_dir / ".restate-backup.lock"
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise BackupError("another Restate volume backup owns the archive lock") from exc
        plan = plan_retention(archive_dir, key_file, keep, now, min_age)
        execute_plan(plan)
        return plan


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="delete only the planned expired paired recovery files")
    parser.add_argument("--keep", type=int, default=14, help="newest complete paired sets to retain")
    args = parser.parse_args()
    archive_dir = Path(os.environ.get("HAWA_BACKUP_ARCHIVE_DEST", str(Path.home() / ".hawa/snapshots_archive")))
    key_file = Path(os.environ.get("HAWA_BACKUP_ARCHIVE_KEYFILE", ""))
    try:
        plan = (apply_retention if args.apply else plan_retention)(archive_dir, key_file, args.keep)
        print(json.dumps(plan.receipt(args.apply)))
        return 0
    except (BackupError, OSError) as exc:
        print(f"Restate retention refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
