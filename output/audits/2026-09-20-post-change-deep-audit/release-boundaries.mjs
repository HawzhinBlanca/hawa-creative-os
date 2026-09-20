// Read-only manifest fault probes. Intercept one in-memory file; no persisted manifest changes.
// Shell injection demonstration runs only printf of a fixed harmless marker, without file/network effects.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const root=process.cwd();
const original=JSON.parse(fs.readFileSync(path.join(root,'RELEASE_MANIFEST.json'),'utf8'));
const originalExec=cp.execSync;
const commands=[];
cp.execSync=function(command,options){
  const result=originalExec.call(this,command,options);
  if(String(command).includes('AUDIT_SHELL_OK')) commands.push({command,stdout:String(result)});
  return result;
};
syncBuiltinESMExports();
const {verifyReleaseManifest}=await import('../../../scripts/verify_release_manifest.ts');
const read=fs.readFileSync, exists=fs.existsSync;
const fakePath=path.join(root,'__in_memory_deep_audit_manifest__.json');
let current;
fs.readFileSync=function(p,...args){if(String(p)===fakePath)return JSON.stringify(current);return read.call(this,p,...args);};
fs.existsSync=function(p){return String(p)===fakePath||exists.call(this,p);};
const vitestBefore=process.env.VITEST;
const seal=()=>{delete current.sha256;current.sha256=crypto.createHash('sha256').update(JSON.stringify(current,null,2)).digest('hex');};
const results=[];
try{
  const sourceHash=crypto.createHash('sha256').update(read.call(fs,path.join(root,'README.md'))).digest('hex');
  current=structuredClone(original);
  current.build.commit='9c22026f444c81494d286354960a0b10efaa1176';
  current.build.treeClean=true;
  current.components=Object.fromEntries(['core','desk','worker'].map(service=>[service,{service,image:'invented-audit-image:latest',sourceFileHashes:{'README.md':sourceHash}}]));
  current.models.registryVersion='2026-09-18.1';
  current.models.pinnedModels=Object.fromEntries(['intake_router','brief_builder','creative_director','visual_judge'].map(role=>[role,{provider:'invented-audit-provider',model:'invented-audit-model'}]));
  seal();
  delete process.env.VITEST;
  results.push({case:'Actual dirty-tree refusal control',observed:verifyReleaseManifest(fakePath)});
  process.env.VITEST='true';
  results.push({case:'Existing obsolete commit, fabricated component images/models and README-only source coverage',condition:'VITEST=true bypasses dirty-tree check; isolates manifest identity predicates',observed:verifyReleaseManifest(fakePath)});
  current.build.commit='HEAD;printf AUDIT_SHELL_OK;#'.padEnd(40,'x');
  seal();
  results.push({case:'40-character manifest commit interpreted as shell program',commit:current.build.commit,observed:verifyReleaseManifest(fakePath),executedShellCommands:commands});
  console.log(JSON.stringify({scope:'Read-only isolated manifest probes; no file/provider/DB writes',results},null,2));
}finally{
  fs.readFileSync=read;fs.existsSync=exists;cp.execSync=originalExec;syncBuiltinESMExports();
  if(vitestBefore===undefined)delete process.env.VITEST;else process.env.VITEST=vitestBefore;
}
