import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../src/services/funnel-monitor.ts'), 'utf8');

/**
 * The funnel monitor decides the health endpoint's verdict, and it was alarming on the absence of
 * two stages this product does not run.
 *
 * Measured in production on 2026-09-21: 14 briefs in 48h, 13 drafts, 0 approvals, 0 deliveries.
 * The pipeline was working — 13 of 14 briefs produced a Canva design — but approvals and
 * publications belong to a flow that ends outside this system, in Canva, so both counts sit at zero
 * permanently. Health therefore read `degraded` permanently, which means a real outage looked
 * exactly like a normal day. A monitor that always alarms is worse than none.
 *
 * These assertions read the source rather than run a query because the condition is the thing worth
 * protecting, and reproducing it needs a populated database the unit suite does not have.
 */
describe('the funnel alarms on no designs, not on an unused approval stage', () => {
  it('stalls when briefs arrive and no draft is produced', () => {
    expect(source).toMatch(/else if \(draftsCount === 0\)/);
    expect(source).toContain('and no design was produced');
  });

  it('no longer treats zero approvals or zero deliveries as a stall', () => {
    // The exact condition that kept production red: `approvalsCount === 0 || deliveriesCount === 0`.
    expect(source).not.toMatch(/approvalsCount === 0 \|\| deliveriesCount === 0/);
  });

  it('still reports both counts, because they are true about a flow that may yet be used', () => {
    expect(source).toMatch(/approvalsCount,/);
    expect(source).toMatch(/deliveriesCount,/);
  });

  it('still distinguishes idle from stalled, so a quiet week is not an incident', () => {
    expect(source).toMatch(/if \(briefsCount === 0\)[\s\S]{0,60}status = 'idle'/);
  });
});

/**
 * A task whose design has been made and sent is no longer `received`. Nothing advanced it, so every
 * task in production read RECEIVED — including designs delivered the previous day with working
 * Canva links — and the records could not tell "designed and sent" apart from "never touched".
 */
describe('a delivered draft advances the task out of received', () => {
  const app = fs.readFileSync(path.join(here, '../src/app.ts'), 'utf8');

  it('moves the task to human_review when a Canva draft is delivered', () => {
    expect(app).toMatch(/'human_review',[\s\S]{0,200}awaiting visual review/);
  });

  it('only ever moves forward, so a re-sent notification cannot drag back an approved task', () => {
    const advanceable = app.match(/const advanceable = \[([\s\S]{0,300}?)\];/);
    expect(advanceable).toBeTruthy();
    const list = advanceable![1];
    for (const before of ['received', 'brief_draft', 'qa']) expect(list).toContain(before);
    for (const after of ['approved', 'complete', 'rejected', 'revision_requested']) {
      expect(list).not.toContain(after);
    }
  });

  it('never fails the delivery over bookkeeping', () => {
    // The Canva link is the thing the owner is waiting for; a failed state write must not cost it.
    expect(app).toMatch(/Failed to advance task state to human_review/);
  });
});
