#!/usr/bin/env tsx
/**
 * Hawa Creative OS — Reference Exemplar Addition & Confirmation CLI (P11)
 * 
 * Supports:
 *   --drop <file-path>               Folder drop intake (adds as status: "pending")
 *   --telegram <file-path> --sender <id>  Telegram intake (adds as status: "pending" with sender)
 *   --desk <file-path> --user <id>   Desk upload intake (adds as status: "pending")
 *   --confirm <filename> --rank <n> --by <name>  Confirmation gate by Art Director (owner)
 *   --list                           Displays all confirmed and pending references
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReferenceLibraryManager } from '../packages/creative/src/studio/reference-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const args = process.argv.slice(2);
  const manager = new ReferenceLibraryManager(rootDir);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage:
  npx tsx scripts/add_exemplar.ts --drop <path-to-image>
  npx tsx scripts/add_exemplar.ts --telegram <path-to-image> --sender <telegram-user-or-chat-id>
  npx tsx scripts/add_exemplar.ts --desk <path-to-image> --user <user-id>
  npx tsx scripts/add_exemplar.ts --confirm <filename> --rank <number> --by <owner-name>
  npx tsx scripts/add_exemplar.ts --list
    `);
    process.exit(0);
  }

  if (args.includes('--list')) {
    const manifest = manager.getManifest();
    console.log(`\n======================================================`);
    console.log(`KAAE REFERENCE LIBRARY (Total Confirmed: ${manifest.totalExemplars})`);
    console.log(`======================================================\n`);
    console.log(`[CONFIRMED REFERENCES]`);
    const confirmed = manifest.exemplars.filter(e => e.status !== 'pending' && e.status !== 'dropped');
    for (const ex of confirmed) {
      console.log(`  #${ex.rank} [${ex.format}] ${ex.filename} (sha: ${ex.sha256.slice(0, 8)}...)`);
    }

    const pending = manifest.exemplars.filter(e => e.status === 'pending');
    console.log(`\n[PENDING REVIEW (${pending.length})]`);
    for (const ex of pending) {
      console.log(`  [PENDING] ${ex.filename} (source: ${ex.source}, sender: ${ex.sender || 'n/a'}, sha: ${ex.sha256.slice(0, 8)}...)`);
    }

    console.log(`\n[DROPPED IN REVIEW (${manifest.droppedInReview.entries.length})]`);
    for (const ex of manifest.droppedInReview.entries) {
      console.log(`  [DROPPED] ${ex.filename} (former rank: #${ex.formerRank}): ${ex.reason}`);
    }
    console.log(`\n======================================================\n`);
    return;
  }

  // Folder drop
  const dropIdx = args.indexOf('--drop');
  if (dropIdx >= 0) {
    const targetFile = args[dropIdx + 1];
    if (!targetFile || !fs.existsSync(targetFile)) {
      console.error(`Error: File not found: ${targetFile}`);
      process.exit(1);
    }
    const buf = fs.readFileSync(targetFile);
    const filename = path.basename(targetFile);
    console.log(`[Folder Drop Intake] Processing: ${filename}`);
    const res = manager.addPendingReference({
      source: 'folder_drop',
      fileBuffer: buf,
      filename,
    });
    if (res.refused) {
      console.error(`❌ REFUSED CIRCULAR OUTPUT:`);
      console.error(`   ${res.reason}`);
      console.error(`   Matching output path: ${res.matchingPath}`);
      process.exit(2);
    }
    console.log(`✓ Added as status "pending" (SHA256: ${res.entry?.sha256})`);
    console.log(`  Dimensions: ${res.entry?.dimensions.width}x${res.entry?.dimensions.height} (${res.entry?.format})`);
    console.log(`  Notice: This reference will NOT be retrieved until confirmed by the owner.`);
    return;
  }

  // Telegram intake
  const tgIdx = args.indexOf('--telegram');
  if (tgIdx >= 0) {
    const targetFile = args[tgIdx + 1];
    const senderIdx = args.indexOf('--sender');
    const sender = senderIdx >= 0 ? args[senderIdx + 1] : 'unknown_telegram_sender';
    if (!targetFile || !fs.existsSync(targetFile)) {
      console.error(`Error: File not found: ${targetFile}`);
      process.exit(1);
    }
    const buf = fs.readFileSync(targetFile);
    const filename = path.basename(targetFile);
    console.log(`[Telegram Intake] Processing: ${filename} from sender: ${sender}`);
    const res = manager.addPendingReference({
      source: 'telegram',
      fileBuffer: buf,
      filename,
      sender,
    });
    if (res.refused) {
      console.error(`❌ REFUSED CIRCULAR OUTPUT:`);
      console.error(`   ${res.reason}`);
      process.exit(2);
    }
    console.log(`✓ Added from Telegram as status "pending" with sender "${sender}"`);
    return;
  }

  // Desk intake
  const deskIdx = args.indexOf('--desk');
  if (deskIdx >= 0) {
    const targetFile = args[deskIdx + 1];
    const userIdx = args.indexOf('--user');
    const user = userIdx >= 0 ? args[userIdx + 1] : 'desk_operator';
    if (!targetFile || !fs.existsSync(targetFile)) {
      console.error(`Error: File not found: ${targetFile}`);
      process.exit(1);
    }
    const buf = fs.readFileSync(targetFile);
    const filename = path.basename(targetFile);
    console.log(`[Desk Upload Intake] Processing: ${filename} from user: ${user}`);
    const res = manager.addPendingReference({
      source: 'desk',
      fileBuffer: buf,
      filename,
      sender: user,
    });
    if (res.refused) {
      console.error(`❌ REFUSED CIRCULAR OUTPUT:`);
      console.error(`   ${res.reason}`);
      process.exit(2);
    }
    console.log(`✓ Added from Desk as status "pending" for user "${user}"`);
    return;
  }

  // Confirmation gate
  const confirmIdx = args.indexOf('--confirm');
  if (confirmIdx >= 0) {
    const filename = args[confirmIdx + 1];
    const rankIdx = args.indexOf('--rank');
    const rank = rankIdx >= 0 ? parseInt(args[rankIdx + 1], 10) : undefined;
    const byIdx = args.indexOf('--by');
    const by = byIdx >= 0 ? args[byIdx + 1] : 'Art Director (owner)';

    console.log(`[Confirmation Gate] Confirming reference: ${filename}`);
    const res = manager.confirmReference(filename, {
      confirmedBy: by,
      targetRank: rank,
    });
    if (!res.success) {
      console.error(`Error confirming reference: ${res.error}`);
      process.exit(1);
    }
    console.log(`✓ Reference confirmed by ${by}!`);
    console.log(`  Assigned rank: #${res.entry?.rank}`);
    console.log(`  Total confirmed references now: ${res.confirmedCount}`);
    console.log(`  Reference is now active and retrievable by P02 retrieval index.`);
    return;
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
