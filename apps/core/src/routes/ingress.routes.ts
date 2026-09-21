import type { RouteContext } from './types.js';

export function registerIngressRoutes(ctx: RouteContext) {
  const { registerRoute, unifiedIngress, channelKillSwitches, problem } = ctx;

  // Ingress Health & Channel Status
  registerRoute('get', '/ingress/status', (c: any) => {
    return c.json({
      status: 'active',
      channels: {
        telegram: !channelKillSwitches.telegram,
        waha: !channelKillSwitches.waha,
      },
      timestamp: new Date().toISOString(),
    }, 200);
  });

  // Channel Kill Switch Toggle
  registerRoute('post', '/ingress/channels/:channel/toggle', async (c: any) => {
    const channel = c.req.param('channel') as 'telegram' | 'waha';
    if (channel !== 'telegram' && channel !== 'waha') {
      return problem(c, 400, 'Invalid Channel', 'Supported channels are telegram and waha');
    }
    const body = await c.req.json().catch(() => ({}));
    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : channelKillSwitches[channel];
    channelKillSwitches[channel] = !enabled;
    return c.json({ channel, enabled, killSwitchActive: channelKillSwitches[channel] }, 200);
  });
}
