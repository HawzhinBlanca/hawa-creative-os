#!/usr/bin/env tsx
/**
 * ADR-280: ingest a folder of the office's archive photos into a client's office photo library.
 *
 *   pnpm exec tsx scripts/office_photo_library_ingest.ts --client <clientId> --source <folder> [--tags <sheet.csv|sheet.json>] [--dry-run]
 *
 * Reads every JPEG, PNG and WebP under --source, measures each one locally (sharpness, the calm area
 * for text, mean luminance, dominant colours), copies it upright into
 * <HAWA_OFFICE_PHOTO_LIBRARY_DIR or data/office-photo-library>/<clientId>/photos/, merges any tags a
 * person filled in, and writes library.json and tags-template.csv beside them. Running it again over
 * the same folder changes nothing. Nothing is uploaded and no model is called.
 *
 * A photo is used in a design only after a person marks it usable, says whether people are in it,
 * and, when they are, records consent (see adrs/280_office_photo_library.md, owner runbook).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ingestOfficePhotoFolder,
  officePhotoLibraryRoot,
  parseOfficePhotoTagSheet,
} from '../packages/creative/src/studio/office-photo-library-store.js';

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const clientId = arg(args, '--client');
  const sourceDir = arg(args, '--source');
  if (args.includes('--help') || !clientId || !sourceDir) {
    console.log('Usage: pnpm exec tsx scripts/office_photo_library_ingest.ts --client <clientId> --source <folder> [--tags <sheet.csv|sheet.json>] [--library-dir <dir>] [--dry-run]');
    return args.includes('--help') ? 0 : 2;
  }
  const tagsFile = arg(args, '--tags');
  const tagRows = tagsFile
    ? parseOfficePhotoTagSheet(readFileSync(tagsFile, 'utf8'), path.extname(tagsFile).toLowerCase() === '.json' ? 'json' : 'csv')
    : undefined;
  const libraryRoot = arg(args, '--library-dir') ? path.resolve(arg(args, '--library-dir')!) : officePhotoLibraryRoot();
  const report = await ingestOfficePhotoFolder({ sourceDir, libraryRoot, clientId, ...(tagRows ? { tagRows } : {}), dryRun: args.includes('--dry-run') });
  console.log(JSON.stringify({
    library: report.manifestPath,
    wrote: report.wrote,
    added: report.added.length,
    updated: report.updated.length,
    unchanged: report.unchanged.length,
    usable: report.usable,
    excluded: report.excluded,
    tagRowsApplied: report.tagRowsApplied,
    tagRowsUnmatched: report.tagRowsUnmatched,
    skipped: report.skipped,
  }, null, 2));
  if (report.excluded > 0) console.log(`${report.excluded} photo(s) are not usable yet: fill in tags-template.csv (usable, people, consent) and run again with --tags.`);
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
