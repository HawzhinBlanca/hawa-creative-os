/**
 * The file store Core writes pictures and design sources to (ADR-035). Production sets HAWA_BLOB_DIR
 * for Core (infra/docker/docker-compose.prod.yml), and each test file gets its own directory
 * (packages/db/test-support/test-database-clone.ts); a test may inject one through createApp's
 * `blobStore` option.
 *
 * Without HAWA_BLOB_DIR there is no store: writers keep the bytes in their rows only, as before
 * release A, and readers read the rows. That is safe until the strip (FILESTORE_DESIGN.md section 5),
 * which the backfill refuses to run without a store.
 */
import { BlobCorruptError, BlobMissingError, blobStoreFromEnv, type BlobStore, type Database, type Kysely } from '@hawa/db';
import { sniffBlobMediaType, type BlobMediaType } from '@hawa/contracts';
import { log } from '../logging.js';

const stores = new WeakMap<object, BlobStore>();

/**
 * Release A's dual-write (FILESTORE_DESIGN.md section 5): the bytes go to the store and stay in their
 * row until the strip, so a put that fails is logged and the write goes on without the file. Returns
 * the stored hash, or null when there is no store, the bytes are not the type expected, or the put
 * failed. The file and its hawa.blobs row commit in the store's own short transaction, before the
 * referencing row: a referencing write that then fails leaves an unreferenced file for the collector.
 */
export async function putToStore(
  store: BlobStore | null | undefined,
  bytes: Uint8Array | null | undefined,
  expected: BlobMediaType | 'image',
  what: string
): Promise<string | null> {
  if (!store || !bytes || !bytes.length) return null;
  const mediaType = sniffBlobMediaType(bytes);
  if (!mediaType || (expected === 'image' ? !mediaType.startsWith('image/') : mediaType !== expected)) {
    log.warn(`[blobs] ${what} was not stored: its bytes are ${mediaType ?? 'of no type the store knows'}`);
    return null;
  }
  try {
    return (await store.put(bytes, mediaType)).sha256;
  } catch (err) {
    log.warn(`[blobs] ${what} was not written to the file store (its bytes stay in the row): ${(err as Error)?.message || err}`);
    return null;
  }
}

/**
 * What a reader gets: the stored file when the row names one the store has, else the row's own bytes
 * (a row from before the store, or one the strip has not reached). Null when there are neither.
 */
export async function readPreferringStore(
  store: BlobStore | null | undefined,
  sha256: string | null | undefined,
  bytes: Uint8Array | null | undefined
): Promise<Buffer | null> {
  if (store && sha256) {
    try {
      return await store.read(sha256);
    } catch (err) {
      // A store that cannot be read at all (a missed mount, no marker) must not take down a reader
      // whose row still has the bytes; it is logged, and only a row without bytes fails with it.
      if (!(err instanceof BlobMissingError) && !(err instanceof BlobCorruptError)) {
        if (!bytes) throw err;
        log.warn(`[blobs] the file store could not be read, so the row's bytes are used: ${(err as Error)?.message || err}`);
      }
    }
  }
  return bytes ? Buffer.from(bytes) : null;
}

export function blobStoreFor(db: Kysely<Database> | null | undefined, injected?: BlobStore | null): BlobStore | null {
  if (injected) return injected;
  if (!db || !process.env.HAWA_BLOB_DIR) return null;
  let store = stores.get(db);
  if (!store || store.root !== process.env.HAWA_BLOB_DIR) {
    store = blobStoreFromEnv(db);
    stores.set(db, store);
  }
  return store;
}
