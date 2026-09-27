import type { JsonObject } from '@hawa/contracts';

export const ROUTING_RESPONSE_SCHEMA: JsonObject = {
  type: 'object', required: ['decision', 'confidence'], additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['route_matched', 'abstain', 'needs_clarification', 'route_ambiguous'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    clientId: { type: ['string', 'null'], maxLength: 256 },
    projectId: { type: ['string', 'null'], maxLength: 256 },
    client: { type: ['string', 'null'], maxLength: 256 },
    project: { type: ['string', 'null'], maxLength: 256 },
    reasoning: { type: 'string', maxLength: 4096 },
  },
};

export const VISUAL_RESPONSE_SCHEMA: JsonObject = {
  type: 'object', required: ['decision', 'passed'], additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['approved', 'rejected', 'revision_requested', 'qualified', 'pass'] },
    passed: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    overallScore: { type: 'number', minimum: 0, maximum: 10 },
    rubricScores: { type: 'object', maxProperties: 32, additionalProperties: { type: 'number', minimum: 0, maximum: 10 } },
    findings: { type: 'array', maxItems: 64, items: { type: ['object', 'string'] } },
  },
};
