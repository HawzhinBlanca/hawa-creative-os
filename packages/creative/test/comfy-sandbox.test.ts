import { describe, it, expect } from 'vitest';
import {
  ComfySandboxValidator,
  type ComfyWorkflowGraph,
} from '../src/comfy-sandbox.js';

describe('Horizon 2: ComfyUI Generative Asset Lab Sandboxing (ADR-007 / ADR-014)', () => {
  const validator = new ComfySandboxValidator();

  it('validates and approves a clean golden workflow graph with certified nodes', () => {
    const goldenGraph: ComfyWorkflowGraph = {
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sha256_sdxl_base_v1_certified_office.safetensors' } },
        { id: 2, type: 'CLIPTextEncode', inputs: { text: 'Summer ice drink with condensation bubbles, commercial studio lighting' } },
        { id: 3, type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
        { id: 4, type: 'KSampler', inputs: { steps: 25, cfg: 7.5 } },
        { id: 5, type: 'VAEDecode' },
        { id: 6, type: 'RembgNode' },
        { id: 7, type: 'SaveImageWebP', inputs: { filename_prefix: 'cutout_drink' } },
      ],
    };

    const res = validator.validateWorkflow(goldenGraph);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.valid).toBe(true);
      expect(res.value.graphHash).toBeDefined();
      expect(res.value.quarantinedNodes).toHaveLength(0);
      expect(res.value.prohibitedNodesFound).toHaveLength(0);
      expect(res.value.violatesLayerIsolation).toBe(false);
    }
  });

  it('detects and quarantines dangerous unapproved or arbitrary script execution nodes', () => {
    const maliciousGraph: ComfyWorkflowGraph = {
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sha256_sdxl_base_v1_certified_office' } },
        { id: 2, type: 'ExecutePythonScript', inputs: { code: 'import os; os.system("cat /etc/passwd")' } },
        { id: 3, type: 'KSampler' },
      ],
    };

    const res = validator.validateWorkflow(maliciousGraph);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('COMFY_SANDBOX_VIOLATION');
      expect(res.error.detail.prohibitedNodesFound).toContain('ExecutePythonScript');
      expect(res.error.detail.valid).toBe(false);
    }
  });

  it('strictly blocks text rasterization nodes to preserve HyCanvas Invariant #2 (Live Editable Text)', () => {
    const rasterTextGraph: ComfyWorkflowGraph = {
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'mock_checkpoint' } },
        { id: 2, type: 'TextRendererFlatten', inputs: { text: 'Bake text into image' } },
      ],
    };

    const res = validator.validateWorkflow(rasterTextGraph);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('COMFY_SANDBOX_VIOLATION');
      expect(res.error.detail.violatesLayerIsolation).toBe(true);
      expect(res.error.message).toContain('violating HyCanvas Invariant #2');
    }
  });

  it('enforces Invariant #4: Reference Pixels Never Ship', () => {
    const res = validator.sanitizeAssetDelivery({
      role: 'reference_only',
      mimeType: 'image/png',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('REFERENCE_PIXEL_SHIPPING_BLOCKED');
      expect(res.error.message).toContain('shippedInArtifact: false');
    }
  });

  it('requires transparent alpha channel for subject cutouts', () => {
    const opaqueCutout = validator.sanitizeAssetDelivery({
      role: 'subject_cutout',
      mimeType: 'image/jpeg',
      hasAlphaChannel: false,
    });

    expect(opaqueCutout.ok).toBe(false);
    if (!opaqueCutout.ok) {
      expect(opaqueCutout.error.code).toBe('CUTOUT_MISSING_ALPHA');
    }

    const transparentCutout = validator.sanitizeAssetDelivery({
      role: 'subject_cutout',
      mimeType: 'image/png',
      hasAlphaChannel: true,
    });

    expect(transparentCutout.ok).toBe(true);
    if (transparentCutout.ok) {
      expect(transparentCutout.value.compliant).toBe(true);
      expect(transparentCutout.value.targetLayerRole).toBe('subject_cutout');
    }
  });
});
