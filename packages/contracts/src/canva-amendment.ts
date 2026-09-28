/** An observation is never an authorization to mutate the native design. */
export type CanvaObservation<T> =
  | { status:'observed'; data:T }
  | { status:'unknown'|'unavailable'|'forbidden'; code:string; message:string };

export interface CanvaAmendmentObservation {
  observedAt:string;
  nativeAmendmentQualified:false;
  basis:{taskId:string;clientId:string;taskVersion:number;bindingId:string;bindingVersion:number;
    designId:string;nativeUpdatedAt:number;pageCount:number|null};
  capabilities:CanvaObservation<string[]>;
  dataset:CanvaObservation<Record<string,{type:'text'|'image'|'chart'|'sheet'}>>;
  limitation:string;
}
