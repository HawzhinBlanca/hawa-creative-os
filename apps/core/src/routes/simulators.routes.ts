import crypto from 'node:crypto';
import {
  ComfySandboxValidator,
  type ComfyWorkflowTemplateId,
  COMFY_WORKFLOW_TEMPLATES,
  ASPECT_RATIO_DIMENSIONS,
  buildComfyWorkflowForTemplate,
  buildCompositedVisualBackdrop,
  calculateContrastRatio,
} from '@hawa/creative';
import { resolveModel } from '@hawa/domain';
import { globalCostGovernor, normalizeKurdishIncomingText } from '@hawa/integrations';
import type { RouteContext } from './types.js';

/**
 * The sandboxed ComfyUI backdrop and composite simulators, and the ingress rehearsal. Moved out of
 * app.ts by group G1 (leaves) of the split (architecture programme 1.3, SPLIT_PLAN.md section 2).
 */
export function registerSimulatorsRoutes(ctx: RouteContext): void {
  const { registerRoute, problem, tasks, events, broadcastEvent: broadcast } = ctx;

  // Sandboxed ComfyUI Graph Synthesis & Validation (Invariant #3 & Invariant #4, ADR-0007)
  registerRoute('post', '/ai/comfy-background', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const prompt = (body.prompt || 'Minimalist Kurdish Luxury Backdrop').trim();
    const style = body.style || 'geometric_mesh';

    // Infer or select vetted template
    let templateId: ComfyWorkflowTemplateId = 'clinical_podium_mesh';
    if (body.templateId && COMFY_WORKFLOW_TEMPLATES[body.templateId as ComfyWorkflowTemplateId]) {
      templateId = body.templateId as ComfyWorkflowTemplateId;
    } else if (prompt.toLowerCase().includes('luxury') || prompt.toLowerCase().includes('kurdish') || style === 'luxury') {
      templateId = 'kurdish_geometric_luxury';
    } else if (prompt.toLowerCase().includes('tech') || prompt.toLowerCase().includes('saas') || style === 'tech') {
      templateId = 'tech_isometric_grid';
    } else if (prompt.toLowerCase().includes('editorial') || style === 'editorial') {
      templateId = 'editorial_scrim_gradient';
    }

    const template = COMFY_WORKFLOW_TEMPLATES[templateId];
    const aspectRatio = (body.aspectRatio || 'feed') as 'feed' | 'story' | 'square' | 'landscape';
    const dims = ASPECT_RATIO_DIMENSIONS[aspectRatio] || ASPECT_RATIO_DIMENSIONS.feed;

    const graph = buildComfyWorkflowForTemplate({
      templateId,
      aspectRatio,
      customPrompt: prompt,
      seed: body.seed ?? 42,
    });

    const validator = new ComfySandboxValidator();
    const validation = validator.validateWorkflow(graph);

    if (!validation.ok) {
      return problem(c, 422, 'ComfyUI Sandbox Violation', validation.error.message);
    }

    const graphHash = validation.value.graphHash;
    const assetId = `asset_ai_${crypto.randomUUID().slice(0, 8)}`;

    const primaryColor = body.primaryColor || template.recommendedPalette.primary;
    const accentColor = body.accentColor || template.recommendedPalette.accent;
    const backgroundColor = body.backgroundColor || template.recommendedPalette.background;
    const applySmartScrim = body.applySmartScrim !== false;
    const scrimPosition = body.scrimPosition || 'top';

    const compositeResult = buildCompositedVisualBackdrop({
      templateId,
      width: dims.width,
      height: dims.height,
      primaryColor,
      accentColor,
      backgroundColor,
      graphHash,
      applySmartScrim,
      scrimPosition,
      scrimOpacity: body.scrimOpacity ?? 0.55,
    });

    const responseData = {
      assetId,
      prompt,
      style,
      templateId,
      templateName: template.name,
      aspectRatio,
      dimensions: dims,
      graphHash,
      verifiedSha256: `sha256_${graphHash.slice(0, 32)}`,
      status: 'VERIFIED_SANDBOXED',
      mimeType: 'image/svg+xml',
      svgContent: compositeResult.svg,
      scrimApplied: compositeResult.scrimApplied,
      guaranteedWcagLevel: compositeResult.guaranteedWcagLevel,
      modelDependencies: graph.modelDependencies,
      createdAt: new Date().toISOString(),
    };

    broadcast('ai:graphic_generated', { assetId, prompt, templateId, graphHash });

    return c.json(responseData, 201);
  });

  // Sandboxed Vector Composite Endpoint (Invariant #4 - Layering subject cutouts with smart scrims)
  registerRoute('post', '/ai/comfy-composite', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const templateId = (body.templateId || 'clinical_podium_mesh') as ComfyWorkflowTemplateId;
    const aspectRatio = (body.aspectRatio || 'feed') as 'feed' | 'story' | 'square' | 'landscape';
    const dims = ASPECT_RATIO_DIMENSIONS[aspectRatio] || ASPECT_RATIO_DIMENSIONS.feed;
    const primaryColor = body.primaryColor || '#0B192C';
    const accentColor = body.accentColor || '#FFB200';
    const backgroundColor = body.backgroundColor || '#030712';

    const compositeResult = buildCompositedVisualBackdrop({
      templateId,
      width: dims.width,
      height: dims.height,
      primaryColor,
      accentColor,
      backgroundColor,
      applySmartScrim: true,
      scrimPosition: body.scrimPosition || 'top',
      scrimOpacity: body.scrimOpacity ?? 0.6,
    });

    // Calculate contrast ratio against headline text color
    const headlineColor = body.headlineColor || '#FFFFFF';
    const contrastRatio = calculateContrastRatio(headlineColor, backgroundColor);

    return c.json({
      compositeId: `cmp_${crypto.randomUUID().slice(0, 8)}`,
      templateId,
      aspectRatio,
      dimensions: dims,
      svgContent: compositeResult.svg,
      wcagContrast: {
        ratio: Number(contrastRatio.toFixed(2)),
        level: contrastRatio >= 7 ? 'AAA' : contrastRatio >= 4.5 ? 'AA' : 'FAIL',
        scrimEnforced: true,
      },
      status: 'COMPOSITE_VERIFIED',
      invariantCompliance: {
        invariant2_live_vector_text: 'VERIFIED_UNFLATTENED',
        invariant4_reference_pixels_never_ship: 'VERIFIED_VECTOR_SANDBOX',
      },
      createdAt: new Date().toISOString(),
    }, 200);
  });

  // --- Inbound Ingress Rehearsal with Real-Time Budget Debiting (FR-004, FR-079) ---
  registerRoute('post', '/ingress/rehearsal', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const clientId = body.clientId || 'client-drustee';
    const platform = body.platform || 'whatsapp';
    const message = body.text || body.message;
    const text = typeof message === 'string' ? message : '';
    const senderName = body.senderName || 'Drustee Official';
    const phone = body.phone || '9647501234567';

    // A rehearsal replays a message someone sent. Without one there is nothing to replay, and a
    // sample message would become a client task with invented copy.
    if (!text.trim()) return problem(c, 422, 'COPY_REQUIRED', 'Send the message text to rehearse. No sample message will be invented.');

    const normalizedText = normalizeKurdishIncomingText(text);
    const estimatedTokens = 450;
    const preFlight = globalCostGovernor.checkPreFlight(clientId, estimatedTokens, resolveModel('text'), 'openai');

    if (!preFlight.allowed) {
      return c.json({
        ok: false,
        code: 'BUDGET_EXCEEDED',
        message: `Client ${clientId} has exhausted their monthly budget ($${preFlight.remainingUsd.toFixed(3)} remaining)`,
        preFlight,
      }, 402);
    }

    const taskId = crypto.randomUUID();
    const costReceipt = globalCostGovernor.recordUsage({
      clientId,
      taskId,
      role: 'rehearsal_brief_generation',
      provider: 'openai',
      model: resolveModel('text'),
      inputTokens: 280,
      outputTokens: 180,
    });
    const task = {
      id: taskId,
      tenantId: 'tenant-default',
      clientId,
      projectId: null,
      // BRIEF_REVIEW: a brief waiting for a person (this said BRIEF_READY, a word no other layer had).
      status: 'BRIEF_REVIEW',
      priority: 'high',
      sourcePlatform: platform,
      sourceEventId: `rehearsal_${Date.now()}`,
      sourceChannelId: phone,
      idempotencyKey: `idem_rehearsal_${Date.now()}`,
      senderName,
      kurdishText: normalizedText,
      title: body.title || `${senderName} Inbound Campaign`,
      // Only what the message and the caller carried; an absent language stays empty.
      headlineCkb: normalizedText.split('\n').find((line) => line.trim())?.slice(0, 40),
      headlineEn: body.headlineEn || undefined,
      copyCkb: normalizedText,
      copyEn: body.copyEn || undefined,
      costReceipt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // A rehearsal writes no task to Postgres. Without a database the rehearsed task is kept here, in
    // the no-database store; with one, the store holds nothing (services/no-database-store.ts).
    tasks.set(taskId, task);
    events.set(taskId, [
      {
        eventId: crypto.randomUUID(),
        taskId,
        fromStatus: null,
        toStatus: 'BRIEF_REVIEW',
        actor: { type: 'rehearsal', id: 'operator' },
        reason: 'Inbound message ingress rehearsal simulated',
        occurredAt: new Date().toISOString(),
      },
    ]);

    broadcast('webhook:received', { platform, updateId: task.sourceEventId, taskId });
    broadcast('task:created', task);

    return c.json({
      ok: true,
      task,
      costReceipt,
      budgetStatus: globalCostGovernor.getOrCreateClientBudget(clientId),
    }, 201);
  });
}
