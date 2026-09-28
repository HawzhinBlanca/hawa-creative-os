# ADR-081: Verify retained file packs before admitting a backup or restore

Date: 2026-09-27
Status: Accepted for implementation; production activation and off-host proof pending
Requirements: FR-070, NFR-003, NFR-006, NFR-020

## Finding

Nightly backup trusts an existing blob-pack index without reading the indexed
packs. A missing or corrupt old pack can therefore be reused in a newly successful
night. The monthly restore extracts archive paths with system tar before checking
file hashes. The optional `gs://` branch can report success without an upload tool,
after a failed upload, or without archiving the file store at all.

## Decision

Use one bounded archive reader for nightly verification and monthly extraction.
Require complete, unambiguous index coverage; safe content-addressed file names;
regular files/directories only; no aliases, links or special files; and exact
SHA-256 content for every selected pack member. Never extract archive-controlled
paths directly. Stage requested files privately and publish the extracted directory
only after every required file has passed. Preserve source archives on failure.

Nightly backup validates all required packs, including retained packs, before
publishing the file manifest and atomically publishing the dump last. A failure
must not advance the success receipt, prune recovery sets or invoke garbage
collection. Restore validates packs before creating its scratch database.

The whole nightly operation holds the existing archive lock exclusively. Restores
hold it shared; standalone Restate capture/retention already use this lock. Nested
capture/retention reuse an inherited descriptor only after checking its inode,
directory and mode. Process exit releases the lock, including a killed process;
there is no stale PID-file takeover. Restore work directories are unique per run.

The watchdog reads the latest completed nightly outcome and original snapshot
time, and checks the corresponding local dump/checksum metadata. A fresh dump from
a failed archive attempt cannot make the monitor healthy. This is receipt freshness,
not a periodic content rehash, off-host verification or whole-system restore proof.

Refuse the incomplete `gs://` transport before making a dump. A supported cloud
transport must copy the complete recovery set and verify readback before admission;
an upload command or a locally synchronized folder is not proof of off-host
durability. Retain local encrypted archive support and explicit plaintext local
test/recovery compatibility. No production destination is changed by this patch.

## Limits

This preserves the existing archive format. Content-address verification detects
missing or changed file bytes; it is not authentication of the legacy database
archive or evidence of coherent database/Restate capture. Independent-host,
off-host and production RPO/RTO qualification remain required under ADR-080.
