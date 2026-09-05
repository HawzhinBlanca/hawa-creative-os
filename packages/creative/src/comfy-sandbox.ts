import crypto from 'node:crypto';

export interface ComfyNode {
  id: string | number;
  type?: string;
  class_type?: string;
  inputs?: Record<string, any>;
  role?: string;
  shippedInArtifact?: boolean;
}

export interface ComfyWorkflowGraph {
  workflowId?: string;
  nodes: ComfyNode[];
  modelDependencies?: Array<{ name: string; sha256: string }>;
}

export interface ComfyValidationDetail {
  valid: boolean;
  graphHash: string;
  quarantinedNodes: string[];
  prohibitedNodesFound: string[];
  violatesLayerIsolation: boolean;
}

export interface ComfyValidationError {
  code: string;
  message: string;
  detail: ComfyValidationDetail;
}

export type ComfyValidationResult =
  | { ok: true; value: ComfyValidationDetail }
  | { ok: false; error: ComfyValidationError };

export interface AssetDeliveryInput {
  role: 'reference_only' | 'subject_cutout' | 'background_asset' | string;
  mimeType: string;
  hasAlphaChannel?: boolean;
  shippedInArtifact?: boolean;
}

export interface AssetDeliverySanitized {
  compliant: boolean;
  targetLayerRole: string;
  mimeType: string;
}

export type AssetDeliveryResult =
  | { ok: true; value: AssetDeliverySanitized }
  | { ok: false; error: { code: string; message: string } };

export const DEFAULT_APPROVED_COMFY_NODES = new Set([
  'CheckpointLoaderSimple',
  'CLIPTextEncode',
  'EmptyLatentImage',
  'KSampler',
  'VAEDecode',
  'RembgNode',
  'SaveImageWebP',
  'TransparentBackgroundRemover',
  'VectorSilhouetteExtractor',
  'ImageScale',
  'LoadImage',
]);

export const PROHIBITED_COMFY_NODES = new Set([
  'ExecutePythonScript',
  'ShellExecution',
  'CustomCodeRunner',
  'ArbitraryPythonScriptRunner',
  'SystemCommand',
]);

export const TEXT_RASTERIZATION_NODES = new Set([
  'TextRendererFlatten',
  'RenderTextToBitmap',
  'BakeTextNode',
  'BitmapTextRenderer',
]);

export class ComfySandboxValidator {
  private approvedNodes: Set<string>;

  constructor(customAllowlist?: string[]) {
    this.approvedNodes = customAllowlist
      ? new Set(customAllowlist)
      : new Set(DEFAULT_APPROVED_COMFY_NODES);
  }

  /**
   * Computes SHA-256 hash of the deterministic workflow graph
   */
  computeGraphHash(graph: ComfyWorkflowGraph): string {
    const serialized = JSON.stringify(graph.nodes, Object.keys(graph.nodes).sort());
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }



  validateWorkflow(graph: ComfyWorkflowGraph): ComfyValidationResult {
    const graphHash = this.computeGraphHash(graph);
    const prohibitedFound: string[] = [];
    const quarantinedNodes: string[] = [];
    let violatesLayerIsolation = false;

    for (const node of graph.nodes) {
      const nodeType = node.type || node.class_type || '';

      if (PROHIBITED_COMFY_NODES.has(nodeType)) {
        prohibitedFound.push(nodeType);
      } else if (TEXT_RASTERIZATION_NODES.has(nodeType)) {
        violatesLayerIsolation = true;
        prohibitedFound.push(nodeType);
      } else if (!this.approvedNodes.has(nodeType)) {
        quarantinedNodes.push(nodeType);
      }
    }

    if (violatesLayerIsolation) {
      return {
        ok: false,
        error: {
          code: 'COMFY_SANDBOX_VIOLATION',
          message: `Raster text node detected, violating HyCanvas Invariant #2 (Live Editable Vector Text). Text must remain addressable vector nodes.`,
          detail: {
            valid: false,
            graphHash,
            quarantinedNodes,
            prohibitedNodesFound: prohibitedFound,
            violatesLayerIsolation: true,
          },
        },
      };
    }

    if (prohibitedFound.length > 0 || quarantinedNodes.length > 0) {
      return {
        ok: false,
        error: {
          code: 'COMFY_SANDBOX_VIOLATION',
          message: `Unapproved or prohibited custom nodes found in ComfyUI workflow graph (ADR-007).`,
          detail: {
            valid: false,
            graphHash,
            quarantinedNodes,
            prohibitedNodesFound: prohibitedFound,
            violatesLayerIsolation: false,
          },
        },
      };
    }

    return {
      ok: true,
      value: {
        valid: true,
        graphHash,
        quarantinedNodes: [],
        prohibitedNodesFound: [],
        violatesLayerIsolation: false,
      },
    };
  }

  sanitizeAssetDelivery(asset: AssetDeliveryInput): AssetDeliveryResult {
    if (asset.role === 'reference_only') {
      return {
        ok: false,
        error: {
          code: 'REFERENCE_PIXEL_SHIPPING_BLOCKED',
          message: 'Invariant #4 violation: Reference Pixels Never Ship (shippedInArtifact: false).',
        },
      };
    }

    if (asset.role === 'subject_cutout' && asset.hasAlphaChannel === false) {
      return {
        ok: false,
        error: {
          code: 'CUTOUT_MISSING_ALPHA',
          message: 'Subject cutouts require a transparent alpha channel.',
        },
      };
    }

    return {
      ok: true,
      value: {
        compliant: true,
        targetLayerRole: asset.role,
        mimeType: asset.mimeType,
      },
    };
  }
}

export type ComfyWorkflowTemplateId =
  | 'clinical_podium_mesh'
  | 'kurdish_geometric_luxury'
  | 'tech_isometric_grid'
  | 'editorial_scrim_gradient';

export interface ComfyWorkflowTemplate {
  id: ComfyWorkflowTemplateId;
  name: string;
  category: 'healthcare' | 'luxury' | 'technology' | 'editorial';
  description: string;
  defaultPrompt: string;
  negativePrompt: string;
  recommendedPalette: { primary: string; accent: string; background: string };
  pinnedModel: { name: string; sha256: string };
}

export const COMFY_WORKFLOW_TEMPLATES: Record<ComfyWorkflowTemplateId, ComfyWorkflowTemplate> = {
  clinical_podium_mesh: {
    id: 'clinical_podium_mesh',
    name: 'Clinical Podium Mesh',
    category: 'healthcare',
    description: 'Clean geometric podium with clinical soft lighting for healthcare and supplement products (Drustee Vitamin D3+K2)',
    defaultPrompt: 'clean clinical laboratory podium, pharmaceutical grade, soft daylighting, minimalist studio setting, subtle geometric shadow',
    negativePrompt: 'blurry, noisy, text, watermark, messy, organic dirt, dark, low quality',
    recommendedPalette: { primary: '#0B192C', accent: '#FFB200', background: '#F8FAFC' },
    pinnedModel: { name: 'sd_xl_turbo_curated.safetensors', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  },
  kurdish_geometric_luxury: {
    id: 'kurdish_geometric_luxury',
    name: 'Kurdish Geometric Luxury',
    category: 'luxury',
    description: 'Neo-Kurdish gold and amber vector motifs, geometric interlacing, and Kurdish star patterns (Aster Hotel & Resort)',
    defaultPrompt: 'neo-kurdish golden geometric star patterns, intricate kurdish architectural interlacing, luxury hospitality backdrop, subtle ambient glow',
    negativePrompt: 'raster text, letters, watermarks, distorted geometry, low resolution, cheap',
    recommendedPalette: { primary: '#D4AF37', accent: '#016E7D', background: '#0A1C1F' },
    pinnedModel: { name: 'sd_xl_turbo_curated.safetensors', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  },
  tech_isometric_grid: {
    id: 'tech_isometric_grid',
    name: 'Tech Isometric Grid',
    category: 'technology',
    description: 'Deep blue and cyan circuit / grid topology for SaaS and infrastructure clients (Nova Tech Systems)',
    defaultPrompt: 'isometric cybernetic grid topology, deep navy and cyan circuit paths, futuristic server room perspective, clean technological depth',
    negativePrompt: 'words, text, unaligned grid, blurry lines, noisy compression',
    recommendedPalette: { primary: '#0284C7', accent: '#38BDF8', background: '#030712' },
    pinnedModel: { name: 'sd_xl_turbo_curated.safetensors', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  },
  editorial_scrim_gradient: {
    id: 'editorial_scrim_gradient',
    name: 'Editorial Scrim Gradient',
    category: 'editorial',
    description: 'Soft multi-stop radial gradient with focal illumination for typography-first social layouts',
    defaultPrompt: 'smooth studio cyclorama gradient, soft studio light falloff, editorial magazine lighting, perfect smooth color transition',
    negativePrompt: 'banding, posterization, dust, artifacts, text, logo',
    recommendedPalette: { primary: '#64748B', accent: '#F59E0B', background: '#0F172A' },
    pinnedModel: { name: 'sd_xl_turbo_curated.safetensors', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  },
};

export const ASPECT_RATIO_DIMENSIONS: Record<'feed' | 'story' | 'square' | 'landscape', { width: number; height: number }> = {
  feed: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  landscape: { width: 1920, height: 1080 },
};

export interface ComfyWorkflowBuildOptions {
  templateId: ComfyWorkflowTemplateId;
  aspectRatio?: 'feed' | 'story' | 'square' | 'landscape';
  customPrompt?: string;
  seed?: number;
}

/**
 * Builds a deterministic, allowlisted ComfyUI workflow graph for a vetted template.
 * Strictly complies with Invariant #4: no text rasterization nodes.
 */
export function buildComfyWorkflowForTemplate(options: ComfyWorkflowBuildOptions): ComfyWorkflowGraph {
  const template = COMFY_WORKFLOW_TEMPLATES[options.templateId] || COMFY_WORKFLOW_TEMPLATES.clinical_podium_mesh;
  const dims = ASPECT_RATIO_DIMENSIONS[options.aspectRatio || 'feed'];
  const promptText = options.customPrompt ? `${options.customPrompt}, ${template.defaultPrompt}` : template.defaultPrompt;
  const seed = options.seed ?? 42;

  return {
    workflowId: `wf_${template.id}_${Date.now().toString(36)}`,
    modelDependencies: [template.pinnedModel],
    nodes: [
      {
        id: 1,
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: template.pinnedModel.name },
      },
      {
        id: 2,
        class_type: 'CLIPTextEncode',
        inputs: { text: promptText },
      },
      {
        id: 3,
        class_type: 'CLIPTextEncode',
        inputs: { text: template.negativePrompt },
      },
      {
        id: 4,
        class_type: 'EmptyLatentImage',
        inputs: { width: dims.width, height: dims.height, batch_size: 1 },
      },
      {
        id: 5,
        class_type: 'KSampler',
        inputs: {
          seed,
          steps: 12,
          cfg: 2.5,
          sampler_name: 'euler_ancestral',
          scheduler: 'normal',
        },
      },
      {
        id: 6,
        class_type: 'VAEDecode',
        inputs: {},
      },
      {
        id: 7,
        class_type: 'TransparentBackgroundRemover',
        inputs: {},
      },
      {
        id: 8,
        class_type: 'SaveImageWebP',
        inputs: { filename_prefix: `hawa_${template.id}` },
      },
    ],
  };
}
