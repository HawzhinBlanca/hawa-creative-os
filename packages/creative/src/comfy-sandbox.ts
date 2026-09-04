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
