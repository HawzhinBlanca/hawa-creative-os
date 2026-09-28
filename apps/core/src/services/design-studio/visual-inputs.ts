import { createHash } from 'node:crypto';
import { StudioVisualInputsError, type StudioVisualBundle, type StudioVisualAsset } from '@hawa/db';
import { captureRenderFontInputs, type RenderFontInputs, type LayoutVisualInput, type PhotoCutoutAsset } from '@hawa/creative';
import type { StageContext, ContentPhoto } from './types.js';
import { layoutVisualInputs } from './stages/asset-inputs.js';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
type ImageRef = { key: string; mime: string };
interface VisualManifest {
  version: 2;
  fonts: RenderFontInputs;
  runId: string;
  clientId: string;
  policySha256: string;
  photos: Array<Omit<ContentPhoto, 'bytes' | 'dataUrl' | 'mimeType'> & ImageRef>;
  exemplarRetrieval?: StageContext['exemplarRetrieval'];
  exemplars: Array<ImageRef & { path: string; label: string; sha256: string }>;
  reference?: ImageRef & { notes: string };
  attachedImage?: ImageRef;
  conditioning: Array<Omit<LayoutVisualInput, 'dataUrl'> & ImageRef>;
  cutouts: Array<(Omit<PhotoCutoutAsset, 'png' | 'shadowPng'> & { key: string; shadowKey?: string }) | null>;
  outcomes: StageContext['cutoutOutcomes'];
  preparation: { cutoutsWanted?: boolean; photoFocus?: unknown; photoSizes?: unknown };
}

function currentFontInputs(): RenderFontInputs {
  try { return captureRenderFontInputs(); }
  catch { throw new StudioVisualInputsError('The current font files cannot be verified. Restore the pinned font environment before continuing.'); }
}

/** Current policies must remain authorized even when the old pixels are retained. */
export function visualPolicySha256(ctx: StageContext): string {
  return sha(JSON.stringify({ clientId: ctx.clientId, pipelineV3: ctx.pipelineV3 === true, width: ctx.width, height: ctx.height,
    referencePack: ctx.referencePack, exemplarPolicySha256: ctx.exemplarPolicySha256 ?? null, promotedRules: ctx.promotedRules, clientRules: ctx.clientRules ?? '',
    latinFont: ctx.latinFont, arabicFont: ctx.arabicFont, ornament: ctx.ornament ?? null,
    style: ctx.style ?? null, imageryStrategy: ctx.imageryStrategy ?? null, requestedBackground: ctx.requestedBackground ?? null }));
}

export async function captureVisualInputs(ctx: StageContext, stages: Record<string, unknown>): Promise<StudioVisualBundle> {
  const assets: StudioVisualAsset[] = [];
  const bytes = (key: string, value: Buffer) => { assets.push({ key, bytes: value }); return key; };
  const image = (key: string, dataUrl: string): ImageRef => {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) throw new StudioVisualInputsError('A visual input is not a supported retained image.');
    return { key: bytes(key, Buffer.from(match[2], 'base64')), mime: match[1] };
  };
  const conditioning = ctx.pipelineV3 ? await layoutVisualInputs(ctx) : [];
  const manifest: VisualManifest = {
    version: 2, fonts: currentFontInputs(), runId: ctx.runId, clientId: ctx.clientId, policySha256: visualPolicySha256(ctx),
    photos: (ctx.photos ?? []).map((p, i) => ({ key: bytes(`photo/${i}`, p.bytes), mime: p.mimeType,
      ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}), ...(p.notes ? { notes: p.notes } : {}) })),
    ...(ctx.exemplarRetrieval ? { exemplarRetrieval: ctx.exemplarRetrieval } : {}),
    exemplars: (ctx.exemplars ?? []).filter(e => e.bytes).map((e, i) => ({ key: bytes(`example/${i}`, e.bytes!), mime: e.mimeType || 'image/png', path: e.path, label: e.label, sha256: sha(e.bytes!) })),
    ...(ctx.reference ? { reference: { ...image('reference', ctx.reference.dataUrl), notes: ctx.reference.notes } } : {}),
    ...(ctx.attachedImage ? { attachedImage: image('attached', ctx.attachedImage) } : {}),
    conditioning: conditioning.map(({ dataUrl, ...metadata }, i) => ({ ...metadata, ...image(`conditioning/${i}`, dataUrl) })),
    cutouts: (ctx.photoCutouts ?? []).map((cut, i) => {
      if (!cut) return null;
      const { png, shadowPng, ...metadata } = cut;
      return { ...metadata, key: bytes(`cutout/${i}`, png), ...(shadowPng ? { shadowKey: bytes(`shadow/${i}`, shadowPng) } : {}) };
    }),
    outcomes: ctx.cutoutOutcomes ?? [],
    preparation: { ...(typeof stages.cutoutsWanted === 'boolean' ? { cutoutsWanted: stages.cutoutsWanted } : {}),
      ...(stages.photoFocus ? { photoFocus: stages.photoFocus } : {}), ...(stages.photoSizes ? { photoSizes: stages.photoSizes } : {}) },
  };
  return { manifest, assets };
}

export function restoreVisualInputs(ctx: StageContext, stages: Record<string, unknown>, bundle: StudioVisualBundle): void {
  const m = bundle.manifest as VisualManifest;
  if (!m || m.version !== 2 || !m.fonts || m.fonts.sha256 !== currentFontInputs().sha256 || m.runId !== ctx.runId || m.clientId !== ctx.clientId || m.policySha256 !== visualPolicySha256(ctx) ||
      !Array.isArray(m.photos) || !Array.isArray(m.exemplars) || !Array.isArray(m.conditioning) || !Array.isArray(m.cutouts)) {
    throw new StudioVisualInputsError('Pinned visual inputs do not match the run or its currently authorized design policy.');
  }
  const assets = new Map(bundle.assets.map(a => [a.key, a.bytes]));
  const get = (key: string): Buffer => {
    const found = assets.get(key);
    if (!found) throw new StudioVisualInputsError('A required pinned visual asset is missing.');
    return found;
  };
  const dataUrl = (ref: ImageRef) => `data:${ref.mime};base64,${get(ref.key).toString('base64')}`;
  ctx.photos = m.photos.map(({ key, mime, ...metadata }) => ({ ...metadata, bytes: get(key), dataUrl: dataUrl({ key, mime }), mimeType: mime as ContentPhoto['mimeType'] }));
  ctx.exemplarRetrieval = m.exemplarRetrieval;
  ctx.exemplars = m.exemplars.map(({ key, mime, ...metadata }) => ({ ...metadata, bytes: get(key), mimeType: mime }));
  ctx.reference = m.reference ? { dataUrl: dataUrl(m.reference), notes: m.reference.notes } : undefined;
  ctx.attachedImage = m.attachedImage ? dataUrl(m.attachedImage) : undefined;
  ctx.visualInputs = m.conditioning.map(({ key, mime, ...metadata }) => ({ ...metadata, dataUrl: dataUrl({ key, mime }) }));
  ctx.photoCutouts = m.cutouts.map(c => {
    if (!c) return undefined;
    const { key, shadowKey, ...metadata } = c;
    return { ...metadata, png: get(key), ...(shadowKey ? { shadowPng: get(shadowKey) } : {}) };
  });
  ctx.cutoutOutcomes = m.outcomes ?? [];
  Object.assign(stages, m.preparation, { cutouts: ctx.cutoutOutcomes });
}
