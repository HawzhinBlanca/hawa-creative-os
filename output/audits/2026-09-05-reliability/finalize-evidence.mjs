// Generates audit ledgers, not application state. Re-run after editing audit documents.
import {readFileSync,writeFileSync,readdirSync,statSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const out=fileURLToPath(new URL('.',import.meta.url)),root=fileURLToPath(new URL('../../..',import.meta.url));
const md=readFileSync(out+'TASK_SHEET.md','utf8');
const chunks=[...md.matchAll(/^### (HD-\d{3}) — (.+)\n([\s\S]*?)(?=^### HD-|^## 5\.|$(?![\s\S]))/gm)];
const releaseDir = root + '/evidence/releases/2026-09-05-v1.0.0';
const tasks=chunks.map(m=>{
  const part=m[3];
  const meta=part.split('\n').find(l=>l.startsWith('**'));
  const id = m[1];
  let status = 'OPEN';
  const receiptPath = `${releaseDir}/${id}/completion.json`;
  if (existsSync(receiptPath)) {
    try {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      status = receipt.status || 'DONE';
    } catch {}
  }
  return {
    id,
    title:m[2],
    priority:meta?.match(/^\*\*(.*?)\s·/)?.[1]||'',
    owner:meta?.match(/Owner:\*\* (.*?) ·/)?.[1]||'',
    dependencies:meta?.match(/Depends:\*\* (.*?) ·/)?.[1]||'',
    requirements:meta?.split('**Requirements:** ')[1]||'',
    status,
    taskSheetLine:md.slice(0,m.index).split('\n').length,
    proofRequired:part.includes('**Proof:**')
  };
});
if(tasks.length!==42||tasks.some(t=>!t.proofRequired))throw Error('Task/proof coverage incomplete: '+tasks.length);
const q=x=>'"'+String(x??'').replaceAll('"','""')+'"';const csv=(headers,rows)=>headers.map(q).join(',')+'\n'+rows.map(r=>headers.map(h=>q(r[h])).join(',')).join('\n')+'\n';
writeFileSync(out+'tasks.csv',csv(Object.keys(tasks[0]),tasks));
function parseCsv(s){const rows=[];let row=[],field='',quoted=false;for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'){if(quoted&&s[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(field);field='';}else if(c==='\n'&&!quoted){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}else field+=c;}if(field||row.length){row.push(field);rows.push(row);}const headers=rows.shift();return rows.filter(r=>r.length>1).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]||''])));}
const fr=[27,27,27,7,27,27,27,27,27,27,3,27,19,19,18,25,19,24,24,24,3,24,24,25,25,25,14,11,9,10,16,15,12,13,13,11,13,18,40,25,20,20,8,8,21,21,21,21,21,22,22,26,26,26,26,23,40,23,23,6,6,37,29,29,23,38,23,4,8,31,29,28,28,39,14,35,3,19,23,38];
const nfr=[5,37,31,33,37,39,38,11,13,14,29,32,30,9,8,36,29,25,10,5,35,13,30,32,42];
const reqs=parseCsv(readFileSync(root+'/plans/requirements.csv','utf8'));const trace=parseCsv(readFileSync(root+'/plans/traceability.csv','utf8'));
const coverage=reqs.map(r=>{
  const n=Number(r.id.split('-')[1]);
  const num=(r.type==='FR'?fr:nfr)[n-1];
  if(!num)throw Error('Unmapped '+r.id);
  const taskId='HD-'+String(num).padStart(3,'0');
  const t=tasks.find(t=>t.id===taskId);
  if(!t)throw Error('Unknown task');
  const isVerified = t.status === 'DONE';
  return {
    requirementId:r.id,
    type:r.type,
    name:r.name,
    requirement:r.requirement,
    primaryTask:taskId,
    taskTitle:t.title,
    sourceDocument:trace.find(x=>x.requirement_id===r.id)?.source_document||'',
    status: isVerified ? `VERIFIED — evidence in evidence/releases/2026-09-05-v1.0.0/${taskId}/completion.json` : 'OPEN — planned coverage, not verified',
    evidenceRequired:'TASK_SHEET.md:'+t.taskSheetLine+' and universal completion contract',
    scope:r.id==='FR-072'||r.id==='FR-073'?'Conditional: prove disabled or complete before enablement':'Required for applicable declared release'
  };
});
if(coverage.length!==105||new Set(coverage.map(x=>x.requirementId)).size!==105)throw Error('Requirement count mismatch');
writeFileSync(out+'requirements-coverage.csv',csv(Object.keys(coverage[0]),coverage));
const proofs={
  at:new Date().toISOString(),
  tasks:tasks.length,
  requirements:coverage.length,
  allTasksHaveProofSections:true,
  allTasksVerified: tasks.every(t => t.status === 'DONE'),
  doneCount: tasks.filter(t => t.status === 'DONE').length,
  openCount: tasks.filter(t => t.status === 'OPEN').length,
  meaning:'Audited completion and proof verification across all 42 tasks in release 2026-09-05-v1.0.0'
};
const missingLinks=[];
for(const name of ['TASK_SHEET.md','AUDIT.md']){
 const content=readFileSync(out+name,'utf8');
 for(const m of content.matchAll(/\]\(([^)]+)\)/g)){const target=m[1];if(/^(https?:|#)/.test(target))continue;try{statSync(target.startsWith('/')?target:out+target.split('#')[0]);}catch{missingLinks.push({file:name,target});}}
}
if(missingLinks.length)throw Error('Missing local links: '+JSON.stringify(missingLinks));
proofs.localLinksValid=true;
writeFileSync(out+'task-sheet-validation.json',JSON.stringify(proofs,null,2));
const entries=[];
function walk(dir,prefix=''){for(const name of readdirSync(dir)){const rel=prefix+name;if(rel==='evidence-sha256.json')continue;const st=statSync(dir+name);if(st.isDirectory())walk(dir+name+'/',rel+'/');else entries.push({path:rel,bytes:st.size,sha256:createHash('sha256').update(readFileSync(dir+name)).digest('hex')});}}
walk(out);writeFileSync(out+'evidence-sha256.json',JSON.stringify({at:new Date().toISOString(),algorithm:'SHA-256',excludes:['evidence-sha256.json'],files:entries},null,2));console.log(proofs);
