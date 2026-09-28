import {expect,it} from 'vitest';
import {auditPublicationReceipts} from '../src/publication-audit.js';
const time='2026-09-27T12:00:00.000Z',options={auditId:'fixture',timestamp:time};
it('counts not-yet-due tasks separately without inventing missing delivery faults',()=>{
 const report=auditPublicationReceipts(['APPROVED','PUBLISHING','AWAITING_APPROVAL'].map((status,i)=>({id:String(i),status,updatedAt:time})),[],[],options);
 expect(report).toMatchObject({pendingTaskCount:3,inSyncCount:0,driftCount:0});
});
it('requires every declared current artifact and a confirmed row hash',()=>{
 const task={id:'t',status:'COMPLETE',updatedAt:time,packageHash:'package',expectedFiles:[{name:'a.png',sha256:'a',size:1},{name:'b.png',sha256:'b',size:2}]};
 const drive=[{taskId:'t',fileId:'f',folderId:'folder',name:'a.png',sha256:'a',byteSize:1}];
 const sheet=[{taskId:'t',rowNumber:1,status:'COMPLETE',packageHash:'package',syncedAt:time,expectedRowHash:'row',observedRowHash:null}];
 const report=auditPublicationReceipts([task],drive,sheet,options);
 expect(report.anomalies.map(a=>a.kind)).toEqual(['CHECKSUM_MISMATCH','RECEIPT_HASH_UNCONFIRMED']);
 expect(report.inSyncCount).toBe(0);expect(auditPublicationReceipts([task],drive,sheet,options)).toEqual(report);
 expect(auditPublicationReceipts([task],[...drive,{...drive[0],fileId:'b',name:'b.png',sha256:'b',byteSize:2}],[{...sheet[0],observedRowHash:'row'}],options)).toMatchObject({inSyncCount:1,driftCount:0});
});
it('does not qualify a delivery whose source manifest or receipt package is unknown or different',()=>{
 const report=auditPublicationReceipts([{id:'t',status:'COMPLETE',updatedAt:time,packageHash:'current',expectedFiles:null}],
  [{taskId:'t',fileId:'f',folderId:'folder',sha256:'artifact',byteSize:1}],
  [{taskId:'t',rowNumber:1,status:'COMPLETE',packageHash:'old',syncedAt:time}],options);
 expect(report.anomalies.map(a=>a.kind)).toEqual(['INCOMPLETE_PUBLICATION_EVIDENCE','CHECKSUM_MISMATCH']);
});
it('matches the approved content once per artifact even when the archive uses a friendly filename',()=>{
 const task={id:'t',status:'COMPLETE',updatedAt:time,packageHash:'package',expectedFiles:[{name:'client-id.pptx',sha256:'approved',size:12}]};
 const drive=[{taskId:'t',fileId:'f',folderId:'folder',name:'client-name.pptx',sha256:'approved',byteSize:12}];
 const sheet=[{taskId:'t',rowNumber:1,status:'COMPLETE',packageHash:'package',syncedAt:time,expectedRowHash:'row',observedRowHash:'row'}];
 expect(auditPublicationReceipts([task],drive,sheet,options)).toMatchObject({inSyncCount:1,driftCount:0});
 const duplicate={...task,expectedFiles:[task.expectedFiles[0],task.expectedFiles[0]]};
 expect(auditPublicationReceipts([duplicate],[{...drive[0],name:'client-id.pptx'}],sheet,options)).toMatchObject({inSyncCount:0,driftCount:1});
 expect(auditPublicationReceipts([task],[drive[0],{...drive[0],fileId:'extra'}],sheet,options)).toMatchObject({inSyncCount:0,driftCount:1});
});
