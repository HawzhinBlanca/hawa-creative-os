/**
 * Read-only, offline audit of the CURRENT GooglePublisher source.
 * Run from repository root: node output/audits/2026-09-20-world-class-audit/PUBLICATION_PROBE.mjs
 * Every HTTP response is synthetic; no database, credentials, env file or external service is read.
 * Exit 0 means the probe executed, NOT that publication is correct. Inspect findingsReproduced.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import ts from 'typescript';

const sourcePath = new URL('../../../packages/integrations/src/google-publisher.ts', import.meta.url);
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { GooglePublisher } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const content = Buffer.from('approved');
const hash = crypto.createHash('sha256').update(content).digest('hex');
const request = {
  taskId: 'synthetic-task-a', clientId: 'synthetic-client-a', designRevisionId: 'synthetic-revision-a',
  approvalId: 'synthetic-approval-a', publicationKey: 'synthetic-publication-a', packageHash: hash,
  files: [{ artifactId: 'synthetic-artifact-a', filename: 'approved.png', mimeType: 'image/png', sha256: hash, byteSize: content.length, content }],
  destination: { productionRootFolderId: 'synthetic-folder-a', sharedDriveId: 'synthetic-drive-a', spreadsheetId: 'synthetic-sheet-a', sheetId: 123 },
  sheetRow: {},
};
const make = () => new GooglePublisher({ oauthToken: crypto.randomUUID() });

function transport({ loseUploadResponse = false, loseSheetResponse = false, wrongChecksum = false, failFirstSheetRead = false, identityReadFails = false } = {}) {
  const files = [], rows = [], overwrites = [], calls = [];
  let uploadLost = false, sheetLost = false, readFailed = false;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    calls.push({ method: options.method || 'GET', url });
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?')) {
      const file = { id: 'synthetic-file-' + (files.length + 1), name: 'approved.png', size: String(content.length), mimeType: 'image/png', sha256Checksum: wrongChecksum ? '0'.repeat(64) : hash };
      files.push(file);
      if (loseUploadResponse && !uploadLost) { uploadLost = true; throw new Error('Synthetic upload committed, response lost'); }
      return Response.json({ id: file.id });
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/')) {
      const file = files.find(f => url.includes('/' + f.id + '?'));
      return file ? Response.json(file) : new Response('not found', { status: 404 });
    }
    if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/synthetic-sheet-a/values/A1:append?')) {
      rows.push(JSON.parse(options.body).values[0]);
      if (loseSheetResponse && !sheetLost) { sheetLost = true; throw new Error('Synthetic row appended, response lost'); }
      return Response.json({ updates: { updatedRange: 'FirstTab!A' + (rows.length + 1) + ':G' + (rows.length + 1) } });
    }
    const identity = url.match(/\/values\/A(\d+):A\d+$/);
    if (identity) {
      if (identityReadFails) return new Response('Synthetic identity read outage', {status:503});
      const row = rows[Number(identity[1])-2];
      return Response.json({values: row ? [[row[0]]] : []});
    }
    if (url.endsWith('/values/A:A')) return Response.json({values:[['task_id'], ...rows.map(r=>[r[0]])]});
    const match = url.match(/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/synthetic-sheet-a\/values\/A(\d+):G\d+/);
    if (match) {
      const index = Number(match[1]) - 2;
      if (options.method === 'PUT') {
        overwrites.push(rows[index]?.[0] ?? null);
        rows[index] = JSON.parse(options.body).values[0];
        return Response.json({});
      }
      if (failFirstSheetRead && !readFailed) { readFailed = true; return new Response('Synthetic read failure', { status: 503 }); }
      return Response.json({ values: rows[index] ? [rows[index]] : [] });
    }
    throw new Error('Offline audit blocked unexpected request');
  };
  return { files, rows, overwrites, calls };
}

const originalFetch = globalThis.fetch;
const evidence = {
  auditedAt: '2026-09-20',
  auditedCommit: '9c22026f444c81494d286354960a0b10efaa1176',
  sourceFile: 'packages/integrations/src/google-publisher.ts',
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  proofClass: 'isolated execution of current source with synthetic provider transport',
  realProviderProof: false, databaseAccess: false, externalNetworkAccess: false,
  findingsReproduced: {},
};
try {
  let h = transport();
  await make().publish({}, request);
  await make().publish({}, request);
  evidence.findingsReproduced.newProcessEquivalentReplay = { driveFiles: h.files.length, sheetRows: h.rows.length, expectedLogicalFiles: 1, expectedLogicalRows: 1 };

  h = transport({ loseUploadResponse: true });
  let publisher = make(), threw = false;
  try { await publisher.publish({}, request); } catch { threw = true; }
  await publisher.publish({}, request);
  evidence.findingsReproduced.lostUploadSuccessResponse = { firstCallThrew: threw, driveFiles: h.files.length, sheetRows: h.rows.length };

  h = transport({ loseSheetResponse: true });
  publisher = make();
  const partial = await publisher.publish({}, request);
  const firstState = partial.value.state;
  const retry = await publisher.publish({}, request);
  evidence.findingsReproduced.lostSheetSuccessResponse = { firstState, finalState: retry.value.state, driveFiles: h.files.length, sheetRows: h.rows.length };

  h = transport({ wrongChecksum: true });
  publisher = make();
  const wrong = await publisher.publish({}, request);
  const laterVerification = await publisher.verify({}, wrong.value.publicationId);
  evidence.findingsReproduced.wrongRemoteChecksumSameSize = { publishState: wrong.value.state, fileMarkedVerified: wrong.value.driveFiles[0].verified, independentLaterVerifyConsistent: laterVerification.value.consistent };

  h = transport({ failFirstSheetRead: true });
  publisher = make();
  const beforeMove = await publisher.publish({}, request);
  const stateBeforeMove = beforeMove.value.state;
  h.rows.unshift(['synthetic-other-task', 'synthetic-other-client', '', '', 'COMPLETE', '', 'synthetic-other-hash']);
  const moved = await publisher.publish({}, request);
  evidence.findingsReproduced.rowMovedBeforeRetry = { initialState: stateBeforeMove, finalState: moved.value.state, overwrittenTaskIds: h.overwrites, finalTaskIds: h.rows.map(r => r[0]), configuredSheetId: request.destination.sheetId, allSheetRangesUnqualified: h.calls.filter(c => c.url.includes('sheets.googleapis.com')).every(c => !c.url.includes('!')) };

  h = transport({ failFirstSheetRead:true, identityReadFails:true });
  publisher = make();
  await publisher.publish({},request);
  h.rows.unshift(['synthetic-other-task','synthetic-other-client','','','COMPLETE','','synthetic-other-hash']);
  const unsafe = await publisher.publish({},request);
  evidence.findingsReproduced.rowMovedIdentityCheckUnavailable = {finalState:unsafe.value.state,overwrittenTaskIds:h.overwrites,finalTaskIds:h.rows.map(r=>r[0])};

  h = transport();
  publisher = make();
  await Promise.all([publisher.publish({}, request), publisher.publish({}, request)]);
  evidence.findingsReproduced.concurrentSameKey = { driveFiles: h.files.length, sheetRows: h.rows.length };
} finally {
  globalThis.fetch = originalFetch;
}
console.log(JSON.stringify(evidence, null, 2));
