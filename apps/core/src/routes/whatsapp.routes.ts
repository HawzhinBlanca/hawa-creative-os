import type { RouteContext } from './types.js';
import { log } from '../logging.js';
import { CHANNEL_INGRESS_USER_ID, isTaskApiStatus } from '@hawa/contracts';
import { TaskStateMachine } from '@hawa/domain';
import { withRlsContext } from '@hawa/db';
import { WahaIngressHandler, verifyActionSignature } from '@hawa/integrations';
import { secretsEqual } from '../core-helpers.js';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { createChatCampaignIntake } from '../services/chat-campaign-intake.js';

/**
 * WhatsApp (WAHA) intake, its health and kill switch, and the signed approve/revise links sent in
 * review messages (architecture programme 1.3, G8). Moved from createApp unchanged.
 */
export function registerWhatsappRoutes(ctx: RouteContext): void {
  const {
    broadcastTransition,
    db,
    events,
    isProduction,
    problem,
    registerRoute,
    resolveTaskWithFallback,
    taskRepo,
    verifyRequestAuth,
    broadcastEvent: broadcast,
  } = ctx;
  const defaultTenantId = DEFAULT_TENANT_ID;
  const { ingestChatCampaignTask } = createChatCampaignIntake(ctx);
  const { executeOmnichannelPublish } = ctx.delivery;

  const wahaIngress = new WahaIngressHandler(process.env.WAHA_WEBHOOK_SECRET);

  registerRoute('post', '/webhooks/whatsapp', async (c: any) => {
    // 1. Office Kill Switch Check (CV-08, FR-071, FR-072)
    if (process.env.WAHA_KILL_SWITCH === 'true') {
      return problem(c, 503, 'Service Unavailable', 'WAHA adapter is currently disabled by office kill switch. Fallback to Hawa Desk intake at /desk.');
    }

    const secret = c.req.header('x-waha-secret') || c.req.header('authorization');
    const signature = c.req.header('x-waha-signature') || c.req.header('x-hub-signature-256');
    const expectedSecret = process.env.WAHA_WEBHOOK_SECRET;

    const rawBody = await c.req.arrayBuffer();
    if (isProduction && !expectedSecret) {
      return problem(c, 503, 'Service Unavailable', 'WAHA_WEBHOOK_SECRET is not configured; unauthenticated WhatsApp intake is refused in production');
    }
    if (expectedSecret) {
      const secretMatches = secretsEqual(secret, expectedSecret) || secretsEqual(secret, `Bearer ${expectedSecret}`);
      const sigMatches = signature && wahaIngress.verifySignature(rawBody, signature);
      if (!secretMatches && !sigMatches) {
        return problem(c, 401, 'Unauthorized', 'Invalid or missing WhatsApp webhook secret token or HMAC signature');
      }
    }
    const bodyText = new TextDecoder().decode(rawBody);
    let json: any = {};
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = { body: bodyText };
    }

    const normalized = wahaIngress.normalize(json, rawBody);
    const sourceEventId = normalized.messageId;

    // 2. Group Allowlist Check (CV-08, FR-071)
    const allowedGroupsEnv = process.env.WAHA_ALLOWED_GROUPS;
    const allowedGroups = allowedGroupsEnv ? allowedGroupsEnv.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (normalized.isGroup && allowedGroups.length > 0 && (!normalized.groupJid || !allowedGroups.includes(normalized.groupJid))) {
      return problem(c, 403, 'Forbidden', `WhatsApp group ${normalized.groupJid || 'unknown'} is not in the office allowlist`);
    }

    const shouldGenerateWa = c.req.query('generate') === 'true' || json.autoGenerate === true || process.env.AUTO_GENERATE_CHAT_DESIGNS === 'true';
    const hostHeaderWa = c.req.header('x-forwarded-host') || c.req.header('host');
    const incomingDeskBaseWa = hostHeaderWa ? `https://${hostHeaderWa}` : undefined;

    const result = await ingestChatCampaignTask({
      platform: 'whatsapp',
      sourceEventId,
      sourceChannelId: normalized.senderPhone,
      senderName: normalized.senderName,
      rawText: normalized.rawText,
      explicitClientId: normalized.detectedClientId,
      autoGenerate: shouldGenerateWa,
      deskBaseUrl: incomingDeskBaseWa,
      rawJson: json,
    });

    return c.json({
      ok: true,
      task: result.task,
      duplicate: result.duplicate === true,
      rawPayloadHash: normalized.rawPayloadHash,
    }, result.duplicate ? 200 : 201);
  });

  // WAHA Session Health Probe (CV-08, FR-072)
  registerRoute('get', '/waha/health', async (c: any) => {
    const isKillSwitchActive = process.env.WAHA_KILL_SWITCH === 'true';
    const allowedGroupsEnv = process.env.WAHA_ALLOWED_GROUPS;
    const allowedGroups = allowedGroupsEnv ? allowedGroupsEnv.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const dedicatedAccount = process.env.WAHA_OFFICE_SESSION || 'office_waha_session';
    const wahaBaseUrl = process.env.WAHA_ENDPOINT || process.env.WAHA_BASE_URL || 'http://127.0.0.1:3000';
    const wahaApiKey = process.env.WAHA_API_KEY || '';

    if (isKillSwitchActive) {
      return c.json({
        ok: true,
        state: 'unavailable',
        detail: {
          killSwitchActive: true,
          dedicatedAccount,
          allowedGroups,
          fallbackChannel: 'desk',
          fallbackInstructions: 'Office kill switch active. Inbound/outbound WhatsApp paused; use Hawa Desk at /desk or Telegram bot.',
        },
      });
    }

    try {
      const res = await fetch(`${wahaBaseUrl}/api/sessions/${dedicatedAccount}`, {
        headers: { 'X-Api-Key': wahaApiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(2000),
      });

      if (!res.ok) {
        return c.json({
          ok: true,
          state: 'unavailable',
          detail: {
            sessionState: 'OFFLINE',
            httpStatus: res.status,
            dedicatedAccount,
            allowedGroups,
            fallbackChannel: 'desk',
            fallbackInstructions: 'WAHA session returned non-200. Intake diverted to Hawa Desk.',
          },
        });
      }

      const sessionData = (await res.json()) as any;
      const status = sessionData.status || 'WORKING';

      if (status === 'SCAN_QR_CODE') {
        return c.json({
          ok: true,
          state: 'reauth_required',
          detail: {
            sessionState: 'SCAN_QR_CODE',
            qrRequired: true,
            dedicatedAccount,
            allowedGroups,
            fallbackChannel: 'desk',
            fallbackInstructions: 'WAHA session disconnected. Scan QR code in WAHA dashboard. Direct users to Hawa Desk intake or Telegram in the interim.',
          },
        });
      }

      if (status === 'STOPPED' || status === 'FAILED') {
        return c.json({
          ok: true,
          state: 'unavailable',
          detail: {
            sessionState: status,
            dedicatedAccount,
            allowedGroups,
            fallbackChannel: 'desk',
            fallbackInstructions: `WAHA session is in ${status} state. Use Hawa Desk intake.`,
          },
        });
      }

      return c.json({
        ok: true,
        state: 'healthy',
        detail: {
          sessionState: 'WORKING',
          dedicatedAccount,
          allowedGroups,
          me: sessionData.me,
        },
      });
    } catch (err: any) {
      return c.json({
        ok: true,
        state: 'unavailable',
        detail: {
          sessionState: 'OFFLINE',
          error: err.message,
          dedicatedAccount,
          allowedGroups,
          fallbackChannel: 'desk',
          fallbackInstructions: 'WAHA server unreachable. Intake diverted to Hawa Desk at /desk or Telegram.',
        },
      });
    }
  });

  // WAHA Kill Switch Management Endpoint (CV-08, FR-072)
  registerRoute('post', '/waha/kill-switch', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required for kill switch');
    }
    if (auth.role !== 'administrator') {
      return problem(c, 403, 'Forbidden', 'Administrator role required for kill switch');
    }
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      // default
    }
    const enabled = body.enabled === true;
    process.env.WAHA_KILL_SWITCH = enabled ? 'false' : 'true';
    return c.json({
      ok: true,
      killSwitchActive: !enabled,
      message: enabled
        ? 'WAHA adapter enabled'
        : 'WAHA adapter disabled by kill switch. Outbound held in outbox; intake returns 503 with Desk fallback.',
    });
  });

  // --- Inbound Action Webhook for Two-Way WhatsApp/Telegram Sign-Off (FR-015, FR-082) ---
  const handleActionCallback = async (c: any) => {
    const isGet = c.req.method === 'GET';
    const taskId = isGet ? c.req.query('taskId') : (await c.req.json().catch(() => ({}))).taskId;
    const action = isGet ? c.req.query('action') : (await c.req.json().catch(() => ({}))).action;
    const sig = isGet ? c.req.query('sig') : (await c.req.json().catch(() => ({}))).sig;
    const phone = isGet ? c.req.query('phone') : (await c.req.json().catch(() => ({}))).phone;
    const notes = isGet ? c.req.query('notes') : (await c.req.json().catch(() => ({}))).notes;

    if (!taskId || !action || !sig) {
      return problem(c, 400, 'Bad Request', 'Missing required query/body params (taskId, action, sig)');
    }

    if (!verifyActionSignature(taskId, action, sig)) {
      return problem(c, 403, 'Forbidden', 'Invalid action signature');
    }

    const task = await resolveTaskWithFallback(taskId);
    if (!task) return problem(c, 404, 'Task Not Found');

    if (action === 'approve') {
      const shouldPublish = isGet
        ? c.req.query('publish') === 'true' || c.req.query('autoPublish') === 'true'
        : (await c.req.json().catch(() => ({}))).publish === true;

      if (shouldPublish) {
        const publishRes = await executeOmnichannelPublish(
          taskId,
          { type: 'adapter', id: phone || 'whatsapp_client' },
          'Approved via WhatsApp interactive action',
          true
        );

        if (!publishRes.ok) {
          const status = (publishRes as any).status || 422;
          return problem(c, status, status === 400 ? 'Bad Request' : 'Publish Error', (publishRes as any).message || 'Omnichannel publication failed verification');
        }

        broadcast('task:approved', { taskId, approvedBy: phone, via: 'whatsapp', publishRes });

        if (isGet) {
          return c.html(`
            <html>
              <body style="font-family: system-ui; background: #0B192C; color: #F8FAFC; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center;">
                <div style="background: rgba(255,255,255,0.06); padding: 40px; border-radius: 16px; border: 1px solid rgba(16, 185, 129, 0.4); max-width: 480px;">
                  <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
                  <h2 style="color: #10B981; margin: 0 0 8px 0;">کەمپینەکە بەسەرکەوتوویی پەسەندکرا و بڵاوکرایەوە</h2>
                  <h3 style="margin: 0 0 16px 0; color: #94A3B8;">Campaign Approved & Published Successfully</h3>
                  <p style="color: #94A3B8; font-size: 14px;">سوپاس، داتاکان ڕەوانەی گووگڵ درایڤ و شیتسی کۆمپانیا کران.<br>Task ID: <code>${taskId}</code></p>
                  <div style="margin-top: 24px; display: flex; gap: 12px; justify-content: center;">
                    <a href="${publishRes.driveFolderUrl}" target="_blank" style="display: inline-block; background: #2563EB; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500;">📁 Google Drive</a>
                    <a href="${publishRes.sheetRowUrl}" target="_blank" style="display: inline-block; background: #059669; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500;">📊 Google Sheets</a>
                  </div>
                </div>
              </body>
            </html>
          `);
        }
        return c.json({ ok: true, status: 'COMPLETE', taskId, message: 'Campaign approved and published successfully', publishRes });
      }

      if (task.status !== 'APPROVED') {
        const effectiveStatus = (task.status === 'RECEIVED' && task.outboundDispatch) ? 'AWAITING_APPROVAL' : task.status;
        const sm = new TaskStateMachine(taskId, effectiveStatus);
        const trans = sm.transition('APPROVED', { type: 'adapter', id: phone || 'whatsapp_client' }, 'Approved via WhatsApp interactive action');
        if (!trans.ok) {
          return problem(c, 409, 'Conflict', trans.error?.message || 'Illegal state transition to APPROVED');
        }
        task.status = 'APPROVED';
        events.get(taskId)?.push(trans.value);
      }

      if (taskRepo && db) {
        try {
          const tenantId = task.tenantId && task.tenantId.includes('-') ? task.tenantId : defaultTenantId;
          await withRlsContext(db, { tenantId, userId: CHANNEL_INGRESS_USER_ID, role: 'operator' }, async (trx) => {
            await taskRepo.transitionState({
              taskId,
              tenantId,
              toState: 'approved',
              actorType: 'adapter',
              actorId: phone || 'whatsapp_client',
              reason: 'Approved via WhatsApp interactive action',
            }, trx);
          });
        } catch (err) {
          log.error('[core:whatsapp:approve] DB transition error:', err);
        }
      }

      broadcast('task:approved', { taskId, approvedBy: phone, via: 'whatsapp' });

      if (isGet) {
        return c.html(`
          <html>
            <body style="font-family: system-ui; background: #0B192C; color: #F8FAFC; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center;">
              <div style="background: rgba(255,255,255,0.06); padding: 40px; border-radius: 16px; border: 1px solid rgba(16, 185, 129, 0.4); max-width: 440px;">
                <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
                <h2 style="color: #10B981; margin: 0 0 8px 0;">کەمپینەکە بەسەرکەوتوویی پەسەندکرا</h2>
                <h3 style="margin: 0 0 16px 0; color: #94A3B8;">Campaign Approved Successfully</h3>
                <p style="color: #94A3B8; font-size: 14px;">سوپاس، داتاکان ڕەوانەی بەشی بڵاوکردنەوە کران.<br>Task ID: <code>${taskId}</code></p>
              </div>
            </body>
          </html>
        `);
      }
      return c.json({ ok: true, status: 'APPROVED', taskId, message: 'Campaign approved successfully' });
    } else {
      const revisionFromStatus = task.status;
      if (task.status !== 'REVISION_REQUESTED') {
        const sm = new TaskStateMachine(taskId, task.status);
        const trans = sm.transition('REVISION_REQUESTED', { type: 'adapter', id: phone || 'whatsapp_client' }, notes || 'Revision requested via WhatsApp');
        if (!trans.ok) {
          return problem(c, 409, 'Conflict', trans.error?.message || 'Illegal state transition to REVISION_REQUESTED');
        }
        task.status = 'REVISION_REQUESTED';
        events.get(taskId)?.push(trans.value);
      }

      let revisionVersion: number | null = null;
      if (taskRepo && db) {
        try {
          const tenantId = task.tenantId && task.tenantId.includes('-') ? task.tenantId : defaultTenantId;
          await withRlsContext(db, { tenantId, userId: CHANNEL_INGRESS_USER_ID, role: 'operator' }, async (trx) => {
            revisionVersion = Number((await taskRepo.transitionState({
              taskId,
              tenantId,
              toState: 'revision_requested',
              actorType: 'adapter',
              actorId: phone || 'whatsapp_client',
              reason: notes || 'Revision requested via WhatsApp',
            }, trx))?.version) || null;
          });
        } catch (err) {
          log.error('[core:whatsapp:revision] DB transition error:', err);
        }
      }

      broadcast('task:revision_requested', { taskId, notes, requestedBy: phone });
      broadcastTransition(taskId, isTaskApiStatus(revisionFromStatus) ? revisionFromStatus : null, 'REVISION_REQUESTED', revisionVersion);

      if (isGet) {
        return c.html(`
          <html>
            <body style="font-family: system-ui; background: #0B192C; color: #F8FAFC; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center;">
              <div style="background: rgba(255,255,255,0.06); padding: 40px; border-radius: 16px; border: 1px solid rgba(239, 68, 68, 0.4); max-width: 440px;">
                <div style="font-size: 48px; margin-bottom: 16px;">✏️</div>
                <h2 style="color: #F87171; margin: 0 0 8px 0;">داواکاری دەستکاری تۆمارکرا</h2>
                <h3 style="margin: 0 0 16px 0; color: #94A3B8;">Revision Request Recorded</h3>
                <p style="color: #94A3B8; font-size: 14px;">تیمی دیزاین ئاگادارکرایەوە بۆ جێبەجێکردنی گۆڕانکارییەکان.<br>Task ID: <code>${taskId}</code></p>
              </div>
            </body>
          </html>
        `);
      }
      return c.json({ ok: true, status: 'REVISION_REQUESTED', taskId, message: 'Revision request recorded' });
    }
  };

  registerRoute('post', '/webhooks/whatsapp/actions', handleActionCallback);
  registerRoute('get', '/webhooks/whatsapp/actions', handleActionCallback);
}
