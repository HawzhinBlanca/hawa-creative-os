import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvalRoleBlocker, describeApproval, describeDelivery, roleLabel } from '../src/services/actionOutcome.js';

const workScreen = () => fs.readFileSync(path.resolve(__dirname, '../src/screens/WorkScreen.tsx'), 'utf8');
const handler = (source: string, name: string) => source.slice(source.indexOf(`const ${name} = async`), source.indexOf('\n  };\n', source.indexOf(`const ${name} = async`)));

describe('the Work screen reports what Approve and Deliver actually did (2026-09-23)', () => {
  it('shows a delivery that reached the requester in Telegram, with Drive refused, as delivered, for 12 s', () => {
    const notice = describeDelivery(
      {
        status: 'DELIVERED_TO_CHAT_ONLY',
        code: 'DRIVE_REFUSED',
        message: 'Drive refused the upload: quota exceeded. The approved file was sent to the requester in Telegram; the Drive archive is not written.',
        requesterNotified: true,
      },
      'APPROVED'
    );
    expect(notice).toEqual({
      tone: 'info',
      text: 'Sent to the requester in Telegram. The Drive copy was not saved: Drive refused the upload: quota exceeded.',
      durationMs: 12000,
    });
  });

  it('reports the other delivery outcomes as before, and a failed refresh only as a note', () => {
    expect(describeDelivery({ status: 'COMPLETE' }, 'COMPLETE')).toEqual({ tone: 'success', text: 'Delivery complete.' });
    expect(describeDelivery({ status: 'PUBLISH_RECONCILIATION', sheetProblem: 'row not found' }, 'PUBLISH_RECONCILIATION').text).toBe(
      'Files delivered to Drive, but the Sheets row is not confirmed: row not found. Deliver again to retry the row.'
    );
    expect(describeDelivery({ status: 'PENDING' }, 'PUBLISHING').text).toBe('Publication requested. Check the task for verified delivery status.');
    expect(describeDelivery({ status: 'DELIVERY_RETRY_REQUIRED' }, 'APPROVED').text).toBe(
      'The archive did not complete. Review the task and start a new delivery action.'
    );
    const unrefreshed = describeDelivery({ status: 'COMPLETE' }, undefined);
    expect(unrefreshed).toEqual({ tone: 'success', text: 'Delivery complete. Refresh the page to see the latest status.' });
    expect(describeApproval('rev-1', 'dec-1', true)).toEqual({ tone: 'success', text: 'Approved Revision rev-1. Decision ID: dec-1.' });
    expect(describeApproval('rev-1', undefined, false)).toEqual({
      tone: 'success',
      text: 'Approved Revision rev-1. Decision ID: recorded. Refresh the page to see the latest status.',
    });
  });

  // Approval is a mutation since ADR-037; test/server-state.test.ts renders a recorded approval whose
  // read afterwards fails. Delivery keeps its handler.
  it('does not call a succeeded delivery failed when only the refresh after it fails', () => {
    const body = handler(workScreen(), 'handleDeliver');
    expect(body).toMatch(/const refreshedTask = await readTaskAgain\(taskId\);/);
    // The "failed" toast belongs to the action's own call only.
    const failed = body.indexOf('Delivery failed');
    expect(failed).toBeGreaterThan(-1);
    expect(failed).toBeLessThan(body.indexOf('readTaskAgain'));
  });

  it('shows the signed-in role instead of a role picker that was never sent, and an operator cannot approve', () => {
    expect(approvalRoleBlocker('operator')).toMatch(/^Approval needs an art director or administrator sign-in/);
    expect(approvalRoleBlocker('art_director')).toBeNull();
    expect(approvalRoleBlocker('administrator')).toBeNull();
    expect(approvalRoleBlocker(undefined)).toBeNull();
    expect(roleLabel('art_director')).toBe('Art Director');
    const source = workScreen();
    expect(source).not.toMatch(/Sign-off Role|approverRole|setApproverRole/);
    expect(source).toMatch(/Boolean\(approvalRoleBlocker\(sessionUser\?\.role\)\)/);
  });

  it("keeps a new toast for its own time: an older toast's timer does not clear it", () => {
    const source = workScreen();
    const show = source.slice(source.indexOf('const showToast'), source.indexOf('};', source.indexOf('const showToast')));
    expect(show).toMatch(/clearTimeout\(toastTimer\.current\);\s*toastTimer\.current = setTimeout\(/);
  });
});
