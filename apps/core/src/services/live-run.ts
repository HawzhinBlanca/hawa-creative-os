/**
 * The SQL condition for a design studio run that is still being made (`r` is hawa.design_studio_runs).
 * The Desk, /redo, approval and delivery all use this one rule. Moved from app.ts (architecture
 * programme 1.3, SPLIT_PLAN.md F5).
 */
import { sql } from '@hawa/db';

// A studio run counts as being made only while it moves: a run left mid-stage by a restart stays
// non-terminal for ever (one from 2026-09-14 still read 'briefing' on 2026-09-23).
export const LIVE_RUN = sql`r.status NOT IN ('transferred', 'degraded', 'failed', 'abandoned') AND r.updated_at > now() - interval '30 minutes'`;
