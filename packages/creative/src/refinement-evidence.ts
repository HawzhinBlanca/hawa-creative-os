import { createHash } from 'node:crypto';
import { canonicalJson } from '@hawa/domain';
import { z } from 'zod';
import type { ArtboardSnapshot } from './feedback-miner.js';

const coordinate = z.number().finite();
const box = z.object({ x: coordinate, y: coordinate, width: coordinate.positive(), height: coordinate.positive() });
const node = z.object({
  id: z.string().min(1).max(500).refine(value=>value.trim()===value), type: z.enum(['text', 'shape', 'badge', 'image']),
  text: z.string().max(24000).optional(), color: z.string().max(100).optional(),
  font: z.string().max(200).optional(), fontFamily: z.string().max(200).optional(),
  fontSize: coordinate.positive().optional(), lineHeight: coordinate.positive().optional(),
  box: box.optional(), x: coordinate.optional(), y: coordinate.optional(),
  width: coordinate.positive().optional(), height: coordinate.positive().optional(),
});
const nodes = z.array(node).max(2000).superRefine((items, ctx) => {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) ctx.addIssue({ code:'custom', message:'Duplicate manifest node identity' });
    ids.add(item.id);
    const geometry = [item.x, item.y, item.width, item.height];
    if (geometry.some(v=>v!==undefined) && !geometry.every(v=>v!==undefined)) {
      ctx.addIssue({ code:'custom', message:'Incomplete recorded node geometry' });
    }
    if (item.box && geometry.every(v=>v!==undefined) &&
        geometry.some((v, i)=>v!==[item.box!.x,item.box!.y,item.box!.width,item.box!.height][i])) {
      ctx.addIssue({ code:'custom', message:'Conflicting recorded node geometry' });
    }
  }
});

/** Project only properties actually recorded by the scoped revision capture. */
export function refinementSnapshotFromManifest(clientId: string, taskId: string, manifest: Record<string, unknown>): ArtboardSnapshot {
  const parsed = nodes.safeParse(manifest.nodes);
  if (!parsed.success) throw new Error('REFINEMENT_MANIFEST_UNSUPPORTED: invalid or incomplete recorded nodes');
  return { clientId, taskId, layers: parsed.data.map(n=>({
    id:n.id, type:n.type, ...(n.text!==undefined ? {text:n.text}:{}),
    ...(n.color!==undefined ? {color:n.color}:{}),
    ...(n.fontFamily!==undefined || n.font!==undefined ? {fontFamily:n.fontFamily ?? n.font}:{}),
    ...(n.fontSize!==undefined ? {fontSize:n.fontSize}:{}),
    ...(n.lineHeight!==undefined ? {lineHeight:n.lineHeight}:{}),
    ...(n.box ?? (n.x!==undefined ? {x:n.x,y:n.y!,width:n.width!,height:n.height!}:{})),
  })) };
}

export function refinementSnapshotHash(snapshot: ArtboardSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

export interface ApprovedRefinementEvidence {
  feedbackId: string;
  clientId: string;
  taskId: string;
  beforeRevisionId: string;
  afterRevisionId: string;
  beforeSourceSha256: string;
  afterSourceSha256: string;
  beforeSnapshotSha256: string;
  afterSnapshotSha256: string;
  approvalId: string;
  approvedBy: string;
  actor: { id: string; role?: string };
}
