import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sniffBlobMediaType, type BlobRef } from '@hawa/contracts';
import { imagePixelSize } from '@hawa/creative';
import { sql, type Database, type Kysely } from '@hawa/db';

export const CUSTOMER_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export class CustomerPhotoError extends Error {
  constructor(readonly status: 400|409|413|422|429|503,readonly code:string) {super(code);}
}
export interface CustomerPhoto extends BlobRef {id:string;filename:string;width:number;height:number}
export interface CustomerPhotoManifest {v:1;images:BlobRef[]}

/** Validation before any decoder: file names never become paths and formats never choose a parser. */
export function inspectCustomerPhoto(bytes:Buffer,mediaType:string,filename:string,expectedHash:string) {
  if(!filename || filename.length>255 || /[\\/\x00-\x1f\x7f]/.test(filename)) throw new CustomerPhotoError(400,'DESIGN_PHOTO_INVALID');
  if(!bytes.length || bytes.length>CUSTOMER_PHOTO_MAX_BYTES) throw new CustomerPhotoError(413,'DESIGN_PHOTO_TOO_LARGE');
  if(!['image/png','image/jpeg','image/webp'].includes(mediaType) || sniffBlobMediaType(bytes)!==mediaType)
    throw new CustomerPhotoError(422,'DESIGN_PHOTO_UNREADABLE');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  if(expectedHash!==sha256) throw new CustomerPhotoError(422,'DESIGN_PHOTO_HASH_MISMATCH');
  const size=imagePixelSize(bytes);
  if(!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width<1 || size.height<1 ||
    size.width>12000 || size.height>12000 || size.width*size.height>24000000)
    throw new CustomerPhotoError(422,'DESIGN_PHOTO_DIMENSIONS');
  return {sha256,mediaType:mediaType as BlobRef['mediaType'],size:bytes.length,...size};
}
let decoding=0;
/** Already deployed ffmpeg, forced still-image parser, no network/file access from uploaded bytes. */
export async function decodeCustomerPhoto(bytes:Buffer,mediaType:string):Promise<void> {
  if(decoding>=2) throw new CustomerPhotoError(503,'DESIGN_PHOTO_BUSY');
  decoding++;
  try {
    const decoder={'image/png':'png','image/jpeg':'mjpeg','image/webp':'webp'}[mediaType];
    if(!decoder) throw new CustomerPhotoError(422,'DESIGN_PHOTO_UNREADABLE');
    await new Promise<void>((resolve,reject)=>{
      const process=execFile('ffmpeg',['-nostdin','-v','error','-xerror','-err_detect','explode','-max_alloc','67108864',
        '-threads','1','-protocol_whitelist','pipe','-f','image2pipe','-c:v',decoder,'-i','pipe:0',
        '-frames:v','1','-vf','scale=64:64','-threads','1','-c:v','png','-f','image2pipe','pipe:1'],
        {timeout:8000,maxBuffer:65536,encoding:'buffer',windowsHide:true},(error,stdout,stderr)=>{
          if(error || stderr.toString().trim() || imagePixelSize(stdout)?.width!==64 || imagePixelSize(stdout)?.height!==64) reject(new CustomerPhotoError(error && 'code' in error && error.code==='ENOENT' ? 503 : 422,
            error && 'code' in error && error.code==='ENOENT' ? 'DESIGN_PHOTO_DECODER_UNAVAILABLE' : 'DESIGN_PHOTO_UNREADABLE'));
          else resolve();
        });
      process.stdin?.on('error',()=>undefined);
      process.stdin?.end(bytes);
    });
  } finally {decoding--;}
}
/** Call within the live customer scope. IDs are never enough without the immutable owner/client. */
export async function customerPhotos(trx:Kysely<Database>,tenantId:string,accountId:string,clientId:string,ids:string[]=[]):Promise<CustomerPhoto[]> {
  if(ids.length>20 || new Set(ids).size!==ids.length) throw new CustomerPhotoError(422,'DESIGN_PHOTOS_INVALID');
  if(!ids.length) return [];
  const rows=(await sql<{id:string;filename:string;sha256:string;media_type:BlobRef['mediaType'];size:number;width:number;height:number}>`
    SELECT p.id,p.filename,p.sha256,p.media_type,p.size,p.width,p.height FROM hawa.customer_photo_receipts p
    JOIN hawa.blobs b ON b.sha256=p.sha256 AND b.media_type=p.media_type AND b.size=p.size
    WHERE p.tenant_id=${tenantId}::uuid AND p.account_id=${accountId}::uuid AND p.client_id=${clientId}::uuid
      AND p.id=ANY(${ids}::uuid[])`.execute(trx)).rows;
  if(rows.length!==ids.length || new Set(rows.map(r=>r.sha256)).size!==ids.length)
    throw new CustomerPhotoError(422,'DESIGN_PHOTOS_INVALID');
  return ids.map(id=>{const r=rows.find(r=>r.id===id)!;return {id:r.id,filename:r.filename,sha256:r.sha256,mediaType:r.media_type,size:r.size,width:r.width,height:r.height};});
}
