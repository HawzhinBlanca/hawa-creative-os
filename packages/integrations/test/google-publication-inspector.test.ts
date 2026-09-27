import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { PublicationInspectionInput } from '@hawa/contracts';
import { comparePublicationInspection } from '../../domain/src/publication-inspection.js';
import { GooglePublicationInspector } from '../src/google-publication-inspector.js';
import { sheetRowHash, sheetRowIdentity } from '../src/google-sheet-row.js';
import { FakeSheets } from './fake-sheets.js';

afterEach(()=>vi.unstubAllGlobals());
const id=(n:number)=>`00000000-0000-4000-a000-${String(n).padStart(12,'0')}`;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function fixture(){
  const tenantId=id(1),publicationId=id(2),taskId=id(3),clientId=id(4),artifactId=id(5);
  const scope={tenantId,taskId,spreadsheetId:'sheet',sheetId:2},identity=sheetRowIdentity(scope);
  const expectedValues=[taskId,clientId,'folder','2026-09-27T00:00:00.000Z','COMPLETE','https://drive.google.com/file/d/file/view','a'.repeat(64)];
  const input:PublicationInspectionInput={schemaVersion:1,tenantId,publicationId,taskId,clientId,
    original:{schemaVersion:1,tenantId,publicationId,taskId,clientId,projectId:null,designRevisionId:id(6),approvalId:id(7),publicationKey:'publish',packageHash:'a'.repeat(64),publishedAt:expectedValues[3],
      destination:{sharedDriveId:'drive',productionRootFolderId:'folder',spreadsheetId:'sheet',sheetId:2,relativeFolderParts:[]},
      files:[{artifactId,relativePath:'final.png',storageKey:'blob/final',filename:'final.png',mimeType:'image/png',byteSize:3,sha256:'b'.repeat(64)}]},
    sheet:{schemaVersion:1,tenantId,publicationId,taskId,clientId,spreadsheetId:'sheet',sheetId:2,metadataId:identity.id,metadataValue:identity.value,expectedValues},
    sheetRowSha256:sheetRowHash(expectedValues),files:[{artifactId,fileId:'file',permissionSha256:null}],folderPermissionSha256:null,sheetPermissionSha256:null,priorPermissionSha256:{}};
  const sheets=new FakeSheets();sheets.tabs.set(2,[['header'],[...expectedValues]]);
  sheets.metadata.set(identity.id,{metadataId:identity.id,metadataKey:'hawa.task.v1',metadataValue:identity.value,visibility:'PROJECT',location:{dimensionRange:{sheetId:2,dimension:'ROWS',startIndex:1,endIndex:2}}});
  const folder:Record<string,unknown>={id:'folder',name:'Archive',mimeType:'application/vnd.google-apps.folder',trashed:false,driveId:'drive',version:'1'};
  const file:Record<string,unknown>={id:'file',name:'final.png',mimeType:'image/png',size:'3',sha256Checksum:'b'.repeat(64),trashed:false,parents:['folder'],driveId:'drive',version:'1',properties:{taskId,artifactId,packageHash:'a'.repeat(64)}};
  const calls:{url:URL;method:string}[]=[];
  let override:((url:URL)=>Response|Promise<Response>|undefined)|undefined;
  vi.stubGlobal('fetch',async(url:string|URL|Request,init?:RequestInit)=>{
    const u=new URL(String(url));calls.push({url:u,method:init?.method??'GET'});
    const replacement=override?.(u);if(replacement)return replacement;
    if(u.pathname.startsWith('/v4/'))return sheets.fetch(url,init);
    if(u.pathname.endsWith('/permissions'))return json({permissions:[{id:'office',type:'group',role:'reader'}]});
    if(u.pathname==='/drive/v3/files')return json({incompleteSearch:false,files:[{id:'file'}]});
    return json(u.pathname.endsWith('/folder')?folder:file);
  });
  const inspect=(deadline=new Date(Date.now()+2000).toISOString())=>new GooglePublicationInspector({driveBaseUrl:'https://drive.test',sheetsBaseUrl:'https://sheets.test',token:'synthetic',deadline}).inspect(input);
  return {input,sheets,file,folder,calls,inspect,setOverride:(fn:typeof override)=>{override=fn;}};
}

it('reads independent exact files and moved Sheet metadata without mutating providers or treating observed access as approved',async()=>{
  const f=fixture();f.sheets.tabs.get(2)!.push(['unrelated']);f.sheets.move(2,1,2);
  const observation=await f.inspect(),report=comparePublicationInspection(f.input,observation);
  expect(observation.sheet).toMatchObject({status:'observed',rowNumber:3,rowSha256:f.input.sheetRowSha256});
  expect(report).toMatchObject({status:'unverified',checkedFiles:1});
  expect(report.findings.map(f=>f.code)).toEqual(Array(3).fill('PERMISSIONS_BASELINE_UNAVAILABLE'));
  expect(f.calls.every(c=>c.method==='GET'||c.method==='POST'&&/:(getByDataFilter|batchGetByDataFilter)$/.test(c.url.pathname))).toBe(true);
  expect(f.calls.filter(c=>c.url.pathname.endsWith('/permissions'))).toHaveLength(6);
  expect(f.calls.find(c=>c.url.pathname==='/drive/v3/files')!.url.searchParams.get('driveId')).toBe('drive');
  f.input.folderPermissionSha256=observation.folder!.permissions.sha256;f.input.files[0].permissionSha256=observation.files[0].permissions.sha256;f.input.sheetPermissionSha256=observation.sheet!.permissions.sha256;
  expect(comparePublicationInspection(f.input,observation)).toEqual({status:'consistent',checkedFiles:1,findings:[]});
});

it.each([
  ['parent',{parents:['other']},'DRIVE_METADATA_CHANGED'],['name',{name:'wrong.png'},'DRIVE_METADATA_CHANGED'],
  ['shared drive',{driveId:'other'},'DRIVE_METADATA_CHANGED'],['size',{size:'4'},'DRIVE_METADATA_CHANGED'],
  ['identity',{properties:{}},'DRIVE_METADATA_CHANGED'],['contents',{sha256Checksum:'c'.repeat(64)},'DRIVE_CHECKSUM_CHANGED'],
] as const)('flags changed %s',async(_label,change,code)=>{
  const f=fixture();Object.assign(f.file,change);const report=comparePublicationInspection(f.input,await f.inspect());
  expect(report.status).toBe('divergent');expect(report.findings.some(f=>f.code===code)).toBe(true);
});

it('finds extra files and a changed Sheet link even when the package-hash column still matches',async()=>{
  const f=fixture();f.sheets.tabs.get(2)![1][5]='https://wrong.test/file';
  f.setOverride(u=>u.pathname==='/drive/v3/files'?json({incompleteSearch:false,files:[{id:'file'},{id:'duplicate'}]}):undefined);
  const codes=comparePublicationInspection(f.input,await f.inspect()).findings.map(f=>f.code);
  expect(codes).toContain('DRIVE_DUPLICATES_FOUND');expect(codes).toContain('SHEET_ROW_CHANGED');
});

it.each([403,404])('keeps HTTP %s and missing checksums unverified instead of asserting deletion',async status=>{
  const f=fixture();delete f.file.sha256Checksum;
  f.setOverride(u=>u.pathname.endsWith('/folder')?json({error:'not retained'},status):undefined);
  const observed=await f.inspect(),report=comparePublicationInspection(f.input,observed);
  expect(observed.folder).toMatchObject({status:'unavailable',code:`GOOGLE_HTTP_${status}`});
  expect(report.status).toBe('unverified');expect(report.findings.map(f=>f.code)).toContain('DRIVE_CHECKSUM_UNAVAILABLE');
  expect(JSON.stringify(observed)).not.toContain('not retained');
});

it('reads every permission page and detects drift without blessing an unapproved baseline',async()=>{
  const f=fixture();f.input.priorPermissionSha256.file='f'.repeat(64);
  f.setOverride(u=>u.pathname.endsWith('/permissions')?json(u.searchParams.has('pageToken')?
    {permissions:[{id:'two',type:'user',role:'reader'}]}:{permissions:[{id:'one',type:'group',role:'writer'}],nextPageToken:'next'}):undefined);
  const observed=await f.inspect();expect(observed.files[0].permissions.count).toBe(2);
  const report=comparePublicationInspection(f.input,observed);expect(report.status).toBe('divergent');
  expect(report.findings.map(f=>f.code)).toContain('PERMISSIONS_CHANGED');expect(report.findings.map(f=>f.code)).toContain('PERMISSIONS_BASELINE_UNAVAILABLE');
  expect(observed.files[0].permissions.sha256).toBe(digest([['one','group','writer',false,false,null,[]],['two','user','reader',false,false,null,[]]]));
});

it.each(['loop','changing','invalid','oversize'] as const)('refuses %s permission evidence',async mode=>{
  const f=fixture();let n=0;
  f.setOverride(u=>{
    if(!u.pathname.endsWith('/permissions'))return;
    if(mode==='oversize')return new Response(' ',{headers:{'content-length':'1048577'}});
    if(mode==='invalid')return json({permissions:[{id:'x',type:'user',role:'invented'}]});
    if(mode==='loop')return json({permissions:[],nextPageToken:'loop'});
    return json({permissions:[{id:'x',type:'user',role:++n%2?'reader':'writer'}]});
  });
  const observed=await f.inspect();expect(observed.files[0].permissions.status).toBe('unavailable');
  expect(comparePublicationInspection(f.input,observed).findings.map(f=>f.code)).toContain('PERMISSIONS_READ_UNAVAILABLE');
});

it('refuses incomplete duplicate searches and metadata changing during inspection',async()=>{
  const f=fixture();let reads=0;
  f.setOverride(u=>u.pathname==='/drive/v3/files'?json({incompleteSearch:true,files:[]}):
    u.pathname==='/drive/v3/files/file'?json({...f.file,version:String(++reads)}):undefined);
  const observed=await f.inspect();expect(observed.files[0]).toMatchObject({status:'unavailable',code:'GOOGLE_ITEM_CHANGED_DURING_READ'});
  expect(observed.duplicates.status).toBe('unavailable');
});

it('bounds stalled transport even when fetch ignores abort',async()=>{
  const f=fixture();f.input.sheet=null;f.setOverride(()=>new Promise<Response>(()=>{}));
  const start=Date.now(),observed=await f.inspect(new Date(Date.now()+40).toISOString());
  expect(Date.now()-start).toBeLessThan(1000);expect(observed.folder?.status).toBe('unavailable');
  expect(observed.files[0].status).toBe('unavailable');
});

it('rejects foreign scope and altered row expectations before any network read',async()=>{
  const f=fixture();f.input.clientId=id(9);await f.inspect();expect(f.calls).toHaveLength(0);
  f.input.clientId=id(4);f.input.sheet!.expectedValues[5]='wrong';await f.inspect();expect(f.calls).toHaveLength(0);
});
