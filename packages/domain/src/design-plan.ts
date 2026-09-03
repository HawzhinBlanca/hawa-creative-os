import type { UUID, SHA256, ISODateTime, JsonObject } from '@hawa/contracts';

export type AssetTopology =
  | 'slot_matrix'
  | 'modular_field'
  | 'continuous_scene'
  | 'cutout_stack'
  | 'layered_collage';

export interface VisualIngredient {
  id: string;
  role: 'background' | 'subject_cutout' | 'product_render' | 'accent_vector' | 'texture' | 'official_logo' | 'badge';
  sourceType: 'official_asset' | 'generated_ingredient' | 'vector_shape' | 'template_element';
  sourceSha256?: SHA256;
  modelPrompt?: string;
  workflowId?: string;
  targetWidth: number;
  targetHeight: number;
  transparentBackground: boolean;
}

export interface LayoutZone {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  allowedRoles: string[];
  safeMarginPx: number;
  zIndex: number;
}

export interface ArtDirectionReference {
  referenceId: UUID;
  storageKey: string;
  sha256: SHA256;
  prompt: string;
  modelSnapshot: string;
  shippedInArtifact: false; // Invariant 4: MUST ALWAYS BE FALSE
  analyzedFeatures: {
    palette: string[];
    depthLayers: number;
    textRegions: Array<{ x: number; y: number; width: number; height: number }>;
    focalPoint: { x: number; y: number };
  };
}

export interface DesignPlan {
  planId: UUID;
  briefId: UUID;
  taskId: UUID;
  topology: AssetTopology;
  rationale: string;
  zones: LayoutZone[];
  ingredients: VisualIngredient[];
  artDirectionReference?: ArtDirectionReference;
  estimatedCostUsd: number;
  createdAt: ISODateTime;
}
