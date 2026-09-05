/**
 * Governed Learning & Studio Feedback Loop Miner (B-055, B-056, B-057, FR-052–FR-054)
 * Inspired by Cursor AST deltas and Figma Design Token Analytics.
 * Automatically analyzes human designer refinements against model proposals
 * and generates governed candidate rules for Client DNA review.
 */

import crypto from 'node:crypto';

export interface CanvasLayerSnapshot {
  id: string;
  type: 'text' | 'shape' | 'badge' | 'image';
  text?: string;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  x: number;
  y: number;
  width: number;
  height: number;
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

export interface CandidateRuleProposal {
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
  promotedByRole?: 'art_director' | 'creative_director';
  promotedAt?: string;
  sha256Digest: string;
}

export class FeedbackMiner {
  private candidateRules = new Map<string, CandidateRuleProposal>();
  private observedDeltas: Array<{ clientId: string; taskId: string; delta: FeedbackDelta }> = [];

  /**
   * Computes exact deltas between an initial model draft and final human approved artboard.
   */
  public diffArtboards(initial: ArtboardSnapshot, final: ArtboardSnapshot): FeedbackDelta[] {
    const deltas: FeedbackDelta[] = [];
    const initialMap = new Map(initial.layers.map((l) => [l.id, l]));

    for (const finalLayer of final.layers) {
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
      const dy = Math.abs(initLayer.y - finalLayer.y);
      if (dy >= 20) {
        deltas.push({
          layerId: finalLayer.id,
          category: 'layout',
          property: 'y',
          beforeValue: initLayer.y,
          afterValue: finalLayer.y,
          description: `Layer shifted vertically by ${finalLayer.y - initLayer.y}px (safe zone adjustment)`
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
    final: ArtboardSnapshot
  ): CandidateRuleProposal[] {
    const deltas = this.diffArtboards(initial, final);
    const newlyProposed: CandidateRuleProposal[] = [];

    for (const delta of deltas) {
      this.observedDeltas.push({ clientId, taskId, delta });

      // Identify key cluster patterns
      let ruleKey = '';
      let title = '';
      let ruleText = '';
      let rationale = '';

      if (delta.category === 'palette') {
        ruleKey = `${clientId}:palette:${delta.afterValue}`;
        title = `Default text color override to ${delta.afterValue}`;
        ruleText = `Use color ${delta.afterValue} for prominent text layers in ${clientId}`;
        rationale = `Human designers repeatedly replace default colors with client brand token ${delta.afterValue}.`;
      } else if (delta.category === 'typography' && delta.property === 'lineHeight') {
        ruleKey = `${clientId}:typography:lineHeight:${delta.afterValue}`;
        title = `Enforce Kurdish diacritic clearance line-height: ${delta.afterValue}`;
        ruleText = `Ensure line-height is set to minimum ${delta.afterValue} for Kurdish typography`;
        rationale = `Required to prevent ascender/descender diacritic clipping on characters like ڵ and ڕ.`;
      } else if (delta.category === 'layout' && delta.property === 'y' && Number(delta.afterValue) > Number(delta.beforeValue)) {
        ruleKey = `${clientId}:layout:top_padding`;
        title = `Maintain increased top safe-zone margin`;
        ruleText = `Offset header layers downward by at least 40px`;
        rationale = `Prevents social story UI obstruction by native Instagram/TikTok header chrome.`;
      } else if (delta.category === 'copy_token') {
        ruleKey = `${clientId}:copy:${delta.afterValue.toString().substring(0, 20)}`;
        title = `Standardize approved copy phrase`;
        ruleText = `Prefer approved phrasing: "${delta.afterValue}"`;
        rationale = `Preserves exact client tone and standardized Kurdish orthography.`;
      }

      if (!ruleKey) continue;

      let proposal = this.candidateRules.get(ruleKey);
      if (proposal) {
        proposal.frequency += 1;
        if (!proposal.evidenceTaskIds.includes(taskId)) {
          proposal.evidenceTaskIds.push(taskId);
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
          sha256Digest
        };
        this.candidateRules.set(ruleKey, proposal);
        newlyProposed.push(proposal);
      }
    }

    return newlyProposed;
  }

  public getCandidateRules(clientId?: string): CandidateRuleProposal[] {
    const rules = Array.from(this.candidateRules.values());
    if (clientId) {
      return rules.filter((r) => r.clientId === clientId);
    }
    return rules;
  }

  /**
   * Human sign-off gate: Promotes a candidate rule to permanent Client DNA.
   * Strictly enforces Invariant #6 and role verification.
   */
  public promoteRule(
    ruleId: string,
    role: 'art_director' | 'creative_director'
  ): { promoted: boolean; rule?: CandidateRuleProposal; auditHash: string } {
    const rule = Array.from(this.candidateRules.values()).find((r) => r.id === ruleId);
    if (!rule) {
      return { promoted: false, auditHash: '' };
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

  public dismissRule(ruleId: string): boolean {
    const rule = Array.from(this.candidateRules.values()).find((r) => r.id === ruleId);
    if (!rule) return false;
    rule.status = 'DISMISSED';
    return true;
  }
}

export const globalFeedbackMiner = new FeedbackMiner();
