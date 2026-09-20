// Offline audit only. Intercept one synthetic manifest read; no file/provider/DB writes.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { verifyReleaseManifest } from '../../../scripts/verify_release_manifest.ts';

const root = process.cwd();
const original = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE_MANIFEST.json'), 'utf8'));
const synthetic = structuredClone(original);
synthetic.build.commit = 'f'.repeat(40);
synthetic.build.treeClean = false;
synthetic.components = {};
synthetic.models = { registryVersion: 'not-the-runtime-registry', pinnedModels: {}, promptVersions: {} };
delete synthetic.sha256;
synthetic.sha256 = crypto.createHash('sha256').update(JSON.stringify(synthetic, null, 2)).digest('hex');

const syntheticPath = path.join(root, '__audit_synthetic_manifest_not_on_disk__.json');
const read = fs.readFileSync;
const exists = fs.existsSync;
fs.readFileSync = function (p, ...args) {
  if (String(p) === syntheticPath) return JSON.stringify(synthetic);
  return read.call(this, p, ...args);
};
fs.existsSync = function (p) {
  if (String(p) === syntheticPath) return true;
  return exists.call(this, p);
};
try {
  console.log(JSON.stringify({
    scope: 'Actual source verifier; synthetic in-memory manifest, no writes or network',
    input: { wrongCommit: synthetic.build.commit, dirtyTree: true, componentCount: 0, modelCount: 0 },
    expected: 'Refuse release identity without source/image/model coverage and a real clean build',
    observed: verifyReleaseManifest(syntheticPath),
  }, null, 2));
} finally {
  fs.readFileSync = read;
  fs.existsSync = exists;
}
