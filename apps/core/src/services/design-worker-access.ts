/** ADR-163: the worker can draft and inspect one named task; no office/admin actions. */
export function permitsDesignWorkerRequest(path: string, method: string): boolean {
  const match = /^\/v1\/tasks\/([a-f0-9-]{36})(\/.*)?$/i.exec(path);
  if (!match) return false;
  const suffix = match[2] || '';
  if (method === 'GET') return suffix === '' || suffix === '/canva';
  if (method !== 'POST') return false;
  return ['/notifications/canva-status', '/canva/studio', '/canva/generate',
    '/canva/exports', '/canva/parity-check'].includes(suffix) ||
    /^\/canva\/studio\/[A-Za-z0-9_-]+\/(resume|abandon)$/.test(suffix) ||
    /^\/canva\/(plans|exports)\/[A-Za-z0-9_-]+\/resume$/.test(suffix);
}
