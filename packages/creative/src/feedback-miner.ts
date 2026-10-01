/**
 * Governed Learning & Studio Feedback Loop Miner (B-055, B-056, B-057, FR-052–FR-054)
 * Inspired by structured edit deltas and design token comparisons.
 * Automatically analyzes human designer refinements against model proposals
 * and generates governed candidate rules for Client DNA review.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '@hawa/domain';
import { refinementSnapshotFromManifest, refinementSnapshotHash, type ApprovedRefinementEvidence } from './refinement-evidence.js';

export interface CanvasLayerSnapshot {
  id: string;
  type: 'text' | 'shape' | 'badge' | 'image';
  text?: string;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface ArtboardSnapshot {
  taskId: string;
  clientId: string;
  layers: CanvasLayerSnapshot[];
}

export interface FeedbackDelta {
  layerId: string;
  category: 'typography' | 'palette' | 'copy_token' | 'layout';
  property: string;
  beforeValue: string | number;
  afterValue: string | number;
  description: string;
}

export interface RuleProvenance {
  taskId?: string;
  clientId: string;
  sourcePlatform?: string;
  feedbackId?: string;
  actor?: { id: string; role?: string; name?: string };
  recordedAt: string;
}

export interface RuleExamples {
  positiveExampleTaskIds: string[];
  negativeExampleTaskIds: string[];
}

export interface DesignFeedbackRecord {
  id: string;
  tenantId?: string;
  taskId: string;
  clientId?: string;
  runId?: string | null;
  candidateId?: string | null;
  actorId: string;
  actorRole?: string;
  source?: 'desk' | 'telegram' | 'import';
  verdict: 'approve' | 'reject' | 'revise' | 'rating';
  rating?: number | null;
  notes?: string | null;
  createdAt?: string;
}

export interface CandidateRuleProposal {
  refinementEvidence?: ApprovedRefinementEvidence[];
  id: string;
  clientId: string;
  title: string;
  category: 'typography' | 'palette' | 'copy_token' | 'layout';
  ruleText: string;
  rationale: string;
  frequency: number;
  evidenceTaskIds: string[];
  confidence: number;
  status: 'PROPOSED' | 'PROMOTED' | 'DISMISSED';
  scope: 'task_scoped' | 'client_scoped';
  explicitness: 'explicit_operator_instruction' | 'inferred_ast_delta';
  provenance: RuleProvenance;
  examples: RuleExamples;
  conflicts: string[];
  promotedByRole?: 'art_director' | 'creative_director';
  promotedAt?: string;
  sha256Digest: string;
  dataLineage: 'client_owned' | 'canva_derived_restricted';
}

/** The DNA file is missing (the production image has no config/): said once per process. */
let warnedNoDnaFile = false;

export class FeedbackMiner {
  private candidateRules = new Map<string, CandidateRuleProposal>();
  private refinementEvents = new Map<string, string>();
  private rejectedTaskIds = new Set<string>();
  private feedbackEvents = new Map<string, string>();
  private negativeFeedbackStore: Array<{
    feedbackId: string;
    taskId: string;
    clientId: string;
    feedbackText: string;
    actor: { id: string; role?: string; name?: string };
    recordedAt: string;
  }> = [];

  /**
   * Ingests human design feedback from hawa.design_feedback
   * (e.g. verdicts from Desk Studio panel: approve, reject, revise, rating).
   * Mines candidate rule proposals (status: 'PROPOSED') and updates
   * positive/negative evidence stores.
   */
  public ingestDesignFeedback(
    feedback: DesignFeedbackRecord | DesignFeedbackRecord[],
    context?: { clientId?: string }
  ): CandidateRuleProposal[] {
    const records = Array.isArray(feedback) ? feedback : [feedback];
    const newlyProposed: CandidateRuleProposal[] = [];

    // Validate the whole batch before changing evidence, including duplicate identities
    // inside the batch. PostgreSQL remains authoritative; this guards its local projection.
    const pendingEvents = new Map<string, string>();
    const admitted = records.map(record => {
      const clientId = record.clientId ?? context?.clientId;
      if (typeof clientId !== 'string' || !clientId.trim() || clientId !== clientId.trim() ||
          (context?.clientId !== undefined && context.clientId !== clientId)) {
        throw new Error('Feedback client scope is missing or conflicting');
      }
      for (const value of [record.id, record.taskId, record.actorId]) {
        if (typeof value !== 'string' || !value.trim()) throw new Error('Feedback identity is required');
      }
      const key = JSON.stringify([record.tenantId ?? null, record.id]);
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
        clientId, record.taskId, record.runId ?? null, record.candidateId ?? null,
        record.actorId, record.actorRole ?? null, record.source ?? 'desk', record.verdict,
        record.rating ?? null, record.notes ?? null, record.createdAt ?? null,
      ])).digest('hex');
      const previous = pendingEvents.get(key) ?? this.feedbackEvents.get(key);
      if (previous !== undefined && previous !== fingerprint) throw new Error('Feedback event reuse conflict');
      pendingEvents.set(key, fingerprint);
      return { record, clientId, key, fingerprint, replayed: previous !== undefined };
    });

    for (const { record, clientId, key, fingerprint, replayed } of admitted) {
      if (replayed) continue;

      const actor = {
        id: record.actorId,
        ...(record.actorRole ? { role: record.actorRole } : {}),
      };

      const notes = (record.notes || '').trim();
      const verdict = record.verdict;
      const rating = record.rating !== undefined ? record.rating : null;

      // 1. Negative feedback handling (reject verdict or low rating <= 4)
      if (verdict === 'reject' || (verdict === 'rating' && rating !== null && rating <= 4)) {
        this.recordNegativeFeedback(
          record.taskId,
          clientId,
          notes || `Studio design candidate rejected (rating: ${rating ?? 'N/A'})`,
          actor
        );
      }

      // 2. Positive feedback handling (approve verdict or high rating >= 8)
      if (verdict === 'approve' || (verdict === 'rating' && rating !== null && rating >= 8)) {
        if (!this.isTaskRejected(record.taskId, clientId)) {
          for (const rule of this.candidateRules.values()) {
            if (rule.clientId === clientId && rule.evidenceTaskIds.includes(record.taskId) &&
                !rule.examples.positiveExampleTaskIds.includes(record.taskId)) {
              rule.examples.positiveExampleTaskIds.push(record.taskId);
            }
          }
        }
      }

      // 3. Rule proposal mining from human operator notes
      if (notes.length > 5) {
        const lower = notes.toLowerCase();
        let category: 'typography' | 'palette' | 'copy_token' | 'layout' = 'layout';
        let title = 'Studio Composition Guideline';

        if (
          lower.includes('color') ||
          lower.includes('palette') ||
          lower.includes('gold') ||
          lower.includes('navy') ||
          lower.includes('contrast') ||
          lower.includes('shade') ||
          lower.includes('dark') ||
          lower.includes('apca')
        ) {
          category = 'palette';
          title = 'Studio Palette & Contrast Standard';
        } else if (
          lower.includes('font') ||
          lower.includes('typeface') ||
          lower.includes('verdana') ||
          lower.includes('cairo') ||
          lower.includes('noto') ||
          lower.includes('serif') ||
          lower.includes('size') ||
          lower.includes('line-height') ||
          lower.includes('kerning') ||
          lower.includes('diacritic')
        ) {
          category = 'typography';
          title = 'Studio Typographic Hierarchy Standard';
        } else if (
          lower.includes('copy') ||
          lower.includes('text') ||
          lower.includes('headline') ||
          lower.includes('slogan') ||
          lower.includes('spelling') ||
          lower.includes('phrase')
        ) {
          category = 'copy_token';
          title = 'Studio Standardized Copy Phrase';
        } else {
          category = 'layout';
          title = 'Studio Layout & Grid Standard';
        }

        const existingPromoted = this.getPromotedRules(clientId);
        const conflicts = this.detectConflicts(notes, existingPromoted);

        const id = `crule_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const sha256Digest = crypto
          .createHash('sha256')
          .update(`${clientId}:${record.id || record.taskId}:${notes}`)
          .digest('hex');

        const proposal: CandidateRuleProposal = {
          id,
          clientId,
          title,
          category,
          ruleText: notes,
          rationale: `Derived from human ${verdict} feedback in Design Studio (${record.source || 'desk'})`,
          frequency: 1,
          evidenceTaskIds: [record.taskId],
          confidence: verdict === 'approve' ? 0.85 : 0.75,
          status: 'PROPOSED',
          scope: 'client_scoped',
          explicitness: 'explicit_operator_instruction',
          provenance: {
            taskId: record.taskId,
            clientId,
            sourcePlatform: `studio_${record.source || 'desk'}`,
            feedbackId: record.id,
            actor,
            recordedAt: record.createdAt || new Date().toISOString(),
          },
          examples: {
            positiveExampleTaskIds:
              verdict === 'approve' && !this.isTaskRejected(record.taskId, clientId) ? [record.taskId] : [],
            negativeExampleTaskIds:
              verdict === 'reject' || (rating !== null && rating <= 4) ? [record.taskId] : [],
          },
          conflicts,
          sha256Digest,
          dataLineage: 'client_owned',
        };

        const ruleKey = `${clientId}:feedback:${proposal.sha256Digest.substring(0, 16)}`;
        if (!this.candidateRules.has(ruleKey)) {
          this.candidateRules.set(ruleKey, proposal);
          newlyProposed.push(proposal);
        } else {
          const existing = this.candidateRules.get(ruleKey)!;
          existing.frequency += 1;
          if (!existing.evidenceTaskIds.includes(record.taskId)) {
            existing.evidenceTaskIds.push(record.taskId);
          }
        }
      }
      this.feedbackEvents.set(key, fingerprint);
    }

    return newlyProposed;
  }

  public isTaskRejected(taskId: string, clientId?: string): boolean {
    if (clientId !== undefined) return this.rejectedTaskIds.has(JSON.stringify([clientId, taskId]));
    return Array.from(this.rejectedTaskIds).some(key => JSON.parse(key)[1] === taskId);
  }

  /**
   * Computes exact deltas between an initial model draft and final human approved artboard.
   */
  public diffArtboards(initial: ArtboardSnapshot, final: ArtboardSnapshot): FeedbackDelta[] {
    const deltas: FeedbackDelta[] = [];
    const initialLayers = initial?.layers || [];
    const finalLayers = final?.layers || [];
    const initialMap = new Map(initialLayers.map((l) => [l.id, l]));

    for (const finalLayer of finalLayers) {
      const initLayer = initialMap.get(finalLayer.id);
      if (!initLayer) continue;

      // 1. Text & Copy changes
      if (initLayer.text !== undefined && finalLayer.text !== undefined && initLayer.text !== finalLayer.text) {
        deltas.push({
          layerId: finalLayer.id,
          category: 'copy_token',
          property: 'text',
          beforeValue: initLayer.text,
          afterValue: finalLayer.text,
          description: `Copy modified from "${initLayer.text}" to "${finalLayer.text}"`
        });
      }

      // 2. Palette & Color overrides
      if (initLayer.color && finalLayer.color && initLayer.color.toLowerCase() !== finalLayer.color.toLowerCase()) {
        deltas.push({
          layerId: finalLayer.id,
          category: 'palette',
          property: 'color',
          beforeValue: initLayer.color,
          afterValue: finalLayer.color,
          description: `Color adjusted from ${initLayer.color} to brand shade ${finalLayer.color}`
        });
      }

      // 3. Typography metrics (fontSize, lineHeight)
      if (initLayer.fontSize && finalLayer.fontSize && Math.abs(initLayer.fontSize - finalLayer.fontSize) >= 2) {
        deltas.push({
          layerId: finalLayer.id,
          category: 'typography',
          property: 'fontSize',
          beforeValue: initLayer.fontSize,
          afterValue: finalLayer.fontSize,
          description: `Font size adjusted from ${initLayer.fontSize}px to ${finalLayer.fontSize}px`
        });
      }

      if (initLayer.lineHeight && finalLayer.lineHeight && Math.abs(initLayer.lineHeight - finalLayer.lineHeight) >= 0.05) {
        deltas.push({
          layerId: finalLayer.id,
          category: 'typography',
          property: 'lineHeight',
          beforeValue: initLayer.lineHeight,
          afterValue: finalLayer.lineHeight,
          description: `Line height diacritic clearance adjusted from ${initLayer.lineHeight} to ${finalLayer.lineHeight}`
        });
      }

      // 4. Layout shifts (significant vertical/horizontal repositioning)
      const dy = initLayer.y === undefined || finalLayer.y === undefined ? 0 : Math.abs(initLayer.y - finalLayer.y);
      if (dy >= 20) {
        deltas.push({
          layerId: finalLayer.id,
          category: 'layout',
          property: 'y',
          beforeValue: initLayer.y!,
          afterValue: finalLayer.y!,
          description: `Layer shifted vertically by ${finalLayer.y! - initLayer.y!}px`
        });
      }
    }

    return deltas;
  }

  /**
   * Ingests observed deltas from an approved task and generates candidate rule proposals.
   */
  public ingestTaskRefinements(
    clientId: string,
    taskId: string,
    initial: ArtboardSnapshot,
    final: ArtboardSnapshot,
    evidence?: ApprovedRefinementEvidence
  ): CandidateRuleProposal[] {
    if (!clientId.trim() || !taskId.trim() || [initial, final].some(s=>s.clientId!==clientId || s.taskId!==taskId)) {
      throw new Error('Refinement task/client scope conflict');
    }
    // Validate both snapshots before creating any proposal, even for direct library calls.
    for (const snapshot of [initial,final]) refinementSnapshotFromManifest(clientId,taskId,{nodes:snapshot.layers});
    let eventKey: string | undefined;
    let fingerprint: string | undefined;
    if (evidence) {
      if (evidence.clientId!==clientId || evidence.taskId!==taskId ||
          evidence.beforeSnapshotSha256!==refinementSnapshotHash(initial) ||
          evidence.afterSnapshotSha256!==refinementSnapshotHash(final) ||
          !evidence.feedbackId || !evidence.approvalId || !evidence.actor.id || !evidence.approvedBy) {
        throw new Error('Refinement authority or snapshot hash conflict');
      }
      eventKey=JSON.stringify([clientId,evidence.feedbackId]);
      fingerprint=crypto.createHash('sha256').update(canonicalJson(evidence)).digest('hex');
      const previous=this.refinementEvents.get(eventKey);
      if (previous && previous!==fingerprint) throw new Error('Refinement event reuse conflict');
      if (previous) return [];
    }
    const deltas = this.diffArtboards(initial, final);
    const newlyProposed: CandidateRuleProposal[] = [];

    for (const delta of deltas) {
      // Identify key cluster patterns
      let ruleKey = '';
      let title = '';
      let ruleText = '';
      let rationale = '';

      if (delta.category === 'palette') {
        ruleKey = `${clientId}:palette:${delta.afterValue}`;
        title = `Default text color override to ${delta.afterValue}`;
        ruleText = `Observed color adjustment to ${delta.afterValue}; review its layer role and task applicability.`;
        rationale = `Recorded color difference; repetition is counted across distinct tasks.`;
      } else if (delta.category === 'typography' && delta.property === 'lineHeight') {
        ruleKey = `${clientId}:typography:lineHeight:${delta.afterValue}`;
        title = `Observed line-height: ${delta.afterValue}`;
        ruleText = `Observed line-height adjustment to ${delta.afterValue}; review font, script and task applicability.`;
        rationale = `Recorded typography difference, without inferred glyph or clipping evidence.`;
      } else if (delta.category === 'layout' && delta.property === 'y' && Number(delta.afterValue) > Number(delta.beforeValue)) {
        const distance=Number(delta.afterValue)-Number(delta.beforeValue);
        ruleKey = `${clientId}:layout:y:${distance}`;
        title = `Observed vertical adjustment`;
        ruleText = `Observed vertical adjustment of ${distance}px; review layer role and task applicability.`;
        rationale = `Recorded geometry difference, without inferred platform or safe-zone requirements.`;
      } else if (delta.category === 'copy_token') {
        ruleKey = `${clientId}:copy:${crypto.createHash('sha256').update(String(delta.afterValue)).digest('hex')}`;
        title = `Observed text replacement`;
        ruleText = `Observed replacement phrasing: "${delta.afterValue}"; review context and task applicability.`;
        rationale = `Recorded text difference; no inferred language, tone or client-wide preference.`;
      }

      if (!ruleKey) continue;

      let proposal = this.candidateRules.get(ruleKey);
      if (proposal) {
        if (!proposal.evidenceTaskIds.includes(taskId)) {
          proposal.evidenceTaskIds.push(taskId);
          proposal.frequency = proposal.evidenceTaskIds.length;
        }
        if (evidence && !proposal.refinementEvidence?.some(e=>e.feedbackId===evidence.feedbackId)) {
          (proposal.refinementEvidence ??= []).push(structuredClone(evidence));
        }
        if (evidence && !this.isTaskRejected(taskId,clientId) && !proposal.examples.positiveExampleTaskIds.includes(taskId)) {
          proposal.examples.positiveExampleTaskIds.push(taskId);
        }
        proposal.confidence = Math.min(0.99, 0.5 + proposal.frequency * 0.15);
      } else {
        const id = `crule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const sha256Digest = crypto
          .createHash('sha256')
          .update(`${clientId}:${title}:${ruleText}:${taskId}`)
          .digest('hex');

        proposal = {
          id,
          clientId,
          title,
          category: delta.category,
          ruleText,
          rationale,
          frequency: 1,
          evidenceTaskIds: [taskId],
          confidence: 0.65,
          status: 'PROPOSED',
          scope: 'client_scoped',
          explicitness: 'inferred_ast_delta',
          ...(evidence ? { refinementEvidence: [structuredClone(evidence)] } : {}),
          provenance: {
            taskId,
            clientId,
            ...(evidence ? {feedbackId:evidence.feedbackId,actor:structuredClone(evidence.actor),sourcePlatform:'approved_revision_pair'} : {sourcePlatform:'unverified_snapshot'}),
            recordedAt: new Date().toISOString(),
          },
          examples: {
            positiveExampleTaskIds: evidence && !this.isTaskRejected(taskId, clientId) ? [taskId] : [],
            negativeExampleTaskIds: this.isTaskRejected(taskId, clientId) ? [taskId] : [],
          },
          conflicts: [],
          sha256Digest,
          dataLineage: 'client_owned',
        };
        this.candidateRules.set(ruleKey, proposal);
        newlyProposed.push(proposal);
      }
    }

    if (eventKey && fingerprint) this.refinementEvents.set(eventKey,fingerprint);

    return newlyProposed;
  }

  /**
   * Hydrates rules from canonical Client DNA specification file if present.
   */
  public loadClientDnaRules(clientId?: string): void {
    const isKaae =
      !clientId ||
      clientId === 'c1000000-0000-4000-8000-000000000002' ||
      clientId === 'client-kaae' ||
      clientId === 'client-office-1' ||
      clientId.includes('kaae');
    if (!isKaae) return;

    try {
      const candidates = [
        path.join(process.cwd(), 'config', 'clients', 'kaae.dna.json'),
        path.join(process.cwd(), '..', '..', 'config', 'clients', 'kaae.dna.json'),
        path.join(process.cwd(), '..', 'config', 'clients', 'kaae.dna.json'),
        '/app/config/clients/kaae.dna.json',
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      if (!found) {
        // Said once, not silently skipped: the file is not in the production image.
        if (!warnedNoDnaFile) {
          warnedNoDnaFile = true;
          console.warn(`[feedback-miner] config/clients/kaae.dna.json was not found (${candidates.join(', ')}); its layout rules are not offered as candidates.`);
        }
        return;
      }

      const dna = JSON.parse(fs.readFileSync(found, 'utf-8'));
      const targetClientId = clientId || dna.clientId || 'c1000000-0000-4000-8000-000000000002';
      const layoutRules: string[] = dna.guidelines?.layoutRules || [];

      for (let i = 0; i < layoutRules.length; i++) {
        const text = layoutRules[i];
        const ruleKey = `${targetClientId}:persisted:${i}`;
        if (!this.candidateRules.has(ruleKey)) {
          const id = `rule_dna_${i}`;
          const sha256Digest = crypto.createHash('sha256').update(text).digest('hex');
          this.candidateRules.set(ruleKey, {
            id,
            clientId: targetClientId,
            title: `Client DNA Rule #${i + 1}`,
            category: 'layout',
            ruleText: text,
            rationale: 'Loaded from canonical Client DNA specification',
            frequency: 1,
            evidenceTaskIds: [],
            status: 'PROMOTED',
            promotedByRole: 'creative_director',
            promotedAt: dna.updatedAt || new Date().toISOString(),
            confidence: 1.0,
            scope: 'client_scoped',
            explicitness: 'explicit_operator_instruction',
            provenance: {
              taskId: 'dna_init',
              clientId: targetClientId,
              actor: { id: 'system', role: 'creative_director', name: 'Client DNA' },
              recordedAt: dna.updatedAt || new Date().toISOString(),
            },
            examples: { positiveExampleTaskIds: [], negativeExampleTaskIds: [] },
            conflicts: [],
            sha256Digest,
            dataLineage: 'client_owned',
          });
        }
      }
    } catch {
      // Safe fallback if filesystem access is restricted
    }
  }

  public getCandidateRules(clientId?: string): CandidateRuleProposal[] {
    const isKaae =
      !clientId ||
      clientId === 'c1000000-0000-4000-8000-000000000002' ||
      clientId === 'client-kaae' ||
      clientId === 'client-office-1' ||
      clientId.includes('kaae');
    if (isKaae && (!this.candidateRules.size || !Array.from(this.candidateRules.values()).some((r) => r.clientId === clientId))) {
      this.loadClientDnaRules(clientId);
    }

    const rules = Array.from(this.candidateRules.values());
    if (clientId) {
      return rules.filter((r) => r.clientId === clientId);
    }
    return rules;
  }

  /**
   * Returns all active promoted rules for a client.
   */
  public getPromotedRules(clientId?: string): string[] {
    return this.getCandidateRules(clientId)
      .filter((r) => r.status === 'PROMOTED')
      .map((r) => r.ruleText);
  }

  /**
   * Conflict Detection (FR-053, FR-054):
   * Detects semantic contradictions with existing client rules or prohibited phrases.
   */
  public detectConflicts(
    ruleText: string,
    existingRules: string[] = [],
    prohibitedPhrases: string[] = []
  ): string[] {
    const conflicts: string[] = [];
    const lowerText = ruleText.toLowerCase();

    // 1. Prohibited phrases contradiction check
    for (const phrase of prohibitedPhrases) {
      if (phrase && lowerText.includes(phrase.toLowerCase())) {
        conflicts.push(`Rule contradicts client prohibited phrase "${phrase}"`);
      }
    }

    // 2. Existing layout & typography rules contradiction check
    for (const existing of existingRules) {
      const lowerEx = existing.toLowerCase();
      // Spatial contradiction
      if (
        (lowerText.includes('right') && lowerEx.includes('left')) ||
        (lowerText.includes('left') && lowerEx.includes('right')) ||
        (lowerText.includes('top') && lowerEx.includes('bottom'))
      ) {
        conflicts.push(`Rule orientation conflicts with existing rule: "${existing}"`);
      }
      // Negative contradiction
      if (
        (lowerText.includes('never') || lowerText.includes('prohibit') || lowerText.includes('do not')) &&
        !lowerEx.includes('never') &&
        lowerText.split(' ').some((w) => w.length > 4 && lowerEx.includes(w))
      ) {
        conflicts.push(`Rule restriction conflicts with existing affirmative rule: "${existing}"`);
      }
    }

    return conflicts;
  }

  /**
   * Negative Feedback Recording (FR-052):
   * Explicitly records negative human feedback on a rejected design.
   * Enforces that rejected designs NEVER become positive examples by default.
   */
  public recordNegativeFeedback(
    taskId: string,
    clientId: string,
    feedbackText: string,
    actor: { id: string; role?: string; name?: string }
  ): { feedbackId: string; taskId: string; negativeExampleRecorded: true } {
    const feedbackId = `fb_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.negativeFeedbackStore.push({
      feedbackId,
      taskId,
      clientId,
      feedbackText,
      actor,
      recordedAt: new Date().toISOString(),
    });

    // Mark task as rejected so it can never become a positive example
    this.rejectedTaskIds.add(JSON.stringify([clientId, taskId]));

    // If any candidate rule previously used this task as positive evidence, remove it
    for (const rule of this.candidateRules.values()) {
      if (rule.clientId === clientId && (rule.examples.positiveExampleTaskIds.includes(taskId) || rule.evidenceTaskIds.includes(taskId))) {
        rule.examples.positiveExampleTaskIds = rule.examples.positiveExampleTaskIds.filter((id) => id !== taskId);
        if (!rule.examples.negativeExampleTaskIds.includes(taskId)) {
          rule.examples.negativeExampleTaskIds.push(taskId);
        }
      }
    }

    return { feedbackId, taskId, negativeExampleRecorded: true };
  }

  /**
   * Propose an explicit operator instruction as a candidate rule (FR-052, FR-053).
   */
  public proposeExplicitRule(input: {
    clientId: string;
    taskId?: string;
    title: string;
    category: 'typography' | 'palette' | 'copy_token' | 'layout';
    ruleText: string;
    rationale: string;
    actor: { id: string; role?: string; name?: string };
    existingRules?: string[];
    prohibitedPhrases?: string[];
  }): CandidateRuleProposal {
    const { clientId, taskId, title, category, ruleText, rationale, actor, existingRules = [], prohibitedPhrases = [] } = input;
    const conflicts = this.detectConflicts(ruleText, existingRules, prohibitedPhrases);

    const id = `crule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sha256Digest = crypto
      .createHash('sha256')
      .update(`${clientId}:${title}:${ruleText}:${taskId}:${Date.now()}`)
      .digest('hex');

    const proposal: CandidateRuleProposal = {
      id,
      clientId,
      title,
      category,
      ruleText,
      rationale,
      frequency: 1,
      evidenceTaskIds: taskId ? [taskId] : [],
      confidence: 0.85,
      status: 'PROPOSED',
      scope: 'client_scoped',
      explicitness: 'explicit_operator_instruction',
      provenance: {
        ...(taskId ? {taskId} : {}),
        clientId,
        sourcePlatform: 'owner_instruction',
        actor,
        recordedAt: new Date().toISOString(),
      },
      examples: {
        positiveExampleTaskIds: [],
        negativeExampleTaskIds: taskId && this.isTaskRejected(taskId, clientId) ? [taskId] : [],
      },
      conflicts,
      sha256Digest,
      dataLineage: 'client_owned',
    };

    const ruleKey = `${clientId}:explicit:${id}`;
    this.candidateRules.set(ruleKey, proposal);
    return proposal;
  }

  /**
   * Human sign-off gate: Promotes a candidate rule to permanent Client DNA.
   * Strictly enforces Invariant #6, role verification, and conflict detection.
   */
  public promoteRule(
    ruleId: string,
    role: 'art_director' | 'creative_director'
  ): { promoted: boolean; rule?: CandidateRuleProposal; auditHash: string; reason?: string } {
    const prepared=this.prepareRulePromotion(ruleId,role);
    this.commitRulePromotion(prepared);
    return prepared;
  }

  /** Prepare a reviewed receipt without making it active before a database commit. */
  public prepareRulePromotion(
    ruleId: string,
    role: 'art_director' | 'creative_director'
  ): { promoted: boolean; rule?: CandidateRuleProposal; auditHash: string; reason?: string } {
    if (role !== 'art_director' && role !== 'creative_director') {
      return { promoted: false, auditHash: '', reason: 'UNAUTHORIZED_ROLE' };
    }

    const stored = Array.from(this.candidateRules.values()).find((r) => r.id === ruleId);
    if (!stored) {
      return { promoted: false, auditHash: '', reason: 'RULE_NOT_FOUND' };
    }
    const rule=structuredClone(stored);

    // Conflicting rules stay pending and cannot be promoted (H11)
    if (rule.conflicts && rule.conflicts.length > 0) {
      return { promoted: false, rule, auditHash: '', reason: 'CONFLICTING_RULES_PENDING' };
    }

    rule.status = 'PROMOTED';
    rule.promotedByRole = role;
    rule.promotedAt = new Date().toISOString();

    const auditHash = crypto
      .createHash('sha256')
      .update(`${rule.id}:${rule.status}:${role}:${rule.promotedAt}`)
      .digest('hex');

    return { promoted: true, rule, auditHash };
  }

  public commitRulePromotion(prepared:{promoted:boolean;rule?:CandidateRuleProposal}): void {
    if (!prepared.promoted || !prepared.rule) return;
    const rule=Array.from(this.candidateRules.values()).find(r=>r.id===prepared.rule!.id);
    if (!rule || rule.clientId!==prepared.rule.clientId || rule.sha256Digest!==prepared.rule.sha256Digest) {
      throw new Error('Prepared rule promotion identity conflict');
    }
    Object.assign(rule,structuredClone(prepared.rule));
  }

  /**
   * Reversible Rollback (FR-067):
   * Rolls back a promoted rule to DISMISSED while preserving original history.
   */
  public rollbackPromotedRule(
    ruleId: string,
    actor: string,
    reason: string
  ): { rolledBack: boolean; rule?: CandidateRuleProposal; auditHash: string } {
    const rule = Array.from(this.candidateRules.values()).find((r) => r.id === ruleId);
    if (!rule) {
      return { rolledBack: false, auditHash: '' };
    }

    rule.status = 'DISMISSED';
    const auditHash = crypto
      .createHash('sha256')
      .update(`${rule.id}:REVERTED:${actor}:${reason}:${Date.now()}`)
      .digest('hex');

    return { rolledBack: true, rule, auditHash };
  }

  public dismissRule(ruleId: string): boolean {
    const rule = Array.from(this.candidateRules.values()).find((r) => r.id === ruleId);
    if (!rule) return false;
    if (rule.status === 'PROMOTED') return false;
    rule.status = 'DISMISSED';
    return true;
  }

  public restoreRuleStatus(ruleId: string, status: 'PROPOSED' | 'PROMOTED' | 'DISMISSED'): boolean {
    const rule = Array.from(this.candidateRules.values()).find((r) => r.id === ruleId);
    if (!rule) return false;
    rule.status = status;
    return true;
  }

  /**
   * Data Boundary & Lineage Separation (FR-055, NFR-007):
   * Evaluates data retrieval boundaries, separating permitted client-owned materials
   * from restricted Canva-derived data (cannot be used for external fine-tuning or benchmarking).
   */
  public evaluateDataRetrievalBoundary(
    clientId: string,
    queryPurpose: 'client_generation' | 'external_fine_tuning' | 'benchmark'
  ): {
    clientId: string;
    queryPurpose: string;
    permittedItems: Array<{ id: string; type: string; name: string; lineage: 'client_owned' }>;
    restrictedExcludedItems: Array<{
      id: string;
      type: string;
      name: string;
      lineage: 'canva_derived_restricted';
      reason: string;
    }>;
  } {
    // Client-owned assets (always permitted for client generation)
    const clientOwned = [
      { id: `${clientId}_logo`, type: 'vector_logo', name: 'Official Brand Logo', lineage: 'client_owned' as const },
      { id: `${clientId}_palette`, type: 'brand_palette', name: 'Approved Color Tokens', lineage: 'client_owned' as const },
      { id: `${clientId}_copy`, type: 'approved_copy', name: 'Verbatim Approved Copy Blocks', lineage: 'client_owned' as const },
      { id: `${clientId}_typography`, type: 'font_metadata', name: 'OFL Font Vazirmatn Spec', lineage: 'client_owned' as const },
    ];

    // Restricted Canva-derived assets
    const canvaRestricted = [
      {
        id: 'canva_stock_template_elem_01',
        type: 'canva_proprietary_vector',
        name: 'Canva Stock Ornament Element #4821',
        lineage: 'canva_derived_restricted' as const,
        reason: 'Vendor IP restriction: Canva stock assets cannot be extracted for model fine-tuning or style-memory',
      },
      {
        id: 'canva_layout_heuristic_internal',
        type: 'canva_internal_weights',
        name: 'Canva Magic Switch Layout Heuristic Graph',
        lineage: 'canva_derived_restricted' as const,
        reason: 'Vendor IP restriction: Internal Canva heuristics prohibited in external benchmarks',
      },
    ];

    if (queryPurpose === 'external_fine_tuning' || queryPurpose === 'benchmark') {
      return {
        clientId,
        queryPurpose,
        permittedItems: [], // No client data or restricted data permitted for external fine-tuning
        restrictedExcludedItems: canvaRestricted,
      };
    }

    return {
      clientId,
      queryPurpose,
      permittedItems: clientOwned,
      restrictedExcludedItems: canvaRestricted,
    };
  }
}

export const globalFeedbackMiner = new FeedbackMiner();
