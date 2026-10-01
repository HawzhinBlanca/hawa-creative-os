import {z} from 'zod';
const text = z.string().trim().min(1);
export const explicitLearningInstruction = z.object({
    taskId: z.string().uuid().optional(), title: text.max(200),
    category: z.enum(['typography', 'palette', 'copy_token', 'layout']), ruleText: text.max(24000),
    rationale: text.max(4000).optional(), existingRules: z.array(text.max(24000)).max(100).optional(),
    prohibitedPhrases: z.array(text.max(1000)).max(100).optional(),
}).strict();
export const moderationInput = z.object({
    reason: text.max(1000).optional(), role: z.enum(['art_director', 'creative_director', 'administrator']).optional(),
}).strict();
export const negativeLearningInput = z.object({ taskId: z.string().uuid(), feedbackText: text.max(4000) }).strict();
