import { parseBlobRef, type BlobRef } from './blobs.js';
export interface CustomerPhotoManifest {v:1;images:BlobRef[]}
/** A server manifest must match every task-file byte binding; missing inputs never silently disappear. */
export function orderedCustomerPhotos<T extends {sha256:string;media_type:string;size:string|number}>(value:unknown,refs:T[]):T[] {
  if(value===undefined) return refs;
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid customer photo manifest');
  const manifest=value as Record<string,unknown>;
  if(manifest.v!==1 || !Array.isArray(manifest.images) || manifest.images.length>20 || manifest.images.length!==refs.length)
    throw new Error('Incomplete customer photo manifest');
  // An empty manifest is a website request without photos; it binds that no request photo exists.
  if(manifest.images.length===0) return [];
  const images=manifest.images.map(parseBlobRef);
  if(images.some(i=>!i || !['image/png','image/jpeg','image/webp'].includes(i.mediaType)) ||
    new Set(images.map(i=>i?.sha256)).size!==images.length || new Set(refs.map(r=>r.sha256)).size!==refs.length)
    throw new Error('Invalid customer photo references');
  return images.map(image=>{
    const ref=refs.find(r=>r.sha256===image!.sha256 && r.media_type===image!.mediaType && Number(r.size)===image!.size);
    if(!ref) throw new Error('Customer photo bytes changed or are unavailable');
    return ref;
  });
}

export type CustomerPhotoUsage={mode:'auto'}|{mode:'all'}|{mode:'count';count:number};
export interface CustomerPhotoPolicy {photoCount:number;usage:CustomerPhotoUsage}
