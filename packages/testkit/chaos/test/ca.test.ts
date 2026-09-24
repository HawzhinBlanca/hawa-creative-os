import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { makeChaosCertificates } from '../fakes/ca.ts';

/** One HTTPS GET to 127.0.0.1 under a given server name, trusting only `ca`. */
function get(port: number, servername: string, ca: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, servername, ca, path: '/', headers: { host: servername } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('chaos CA: the fakes answer for the hard-coded provider hosts over real TLS', () => {
  const certs = makeChaosCertificates(['api.telegram.org', 'export-download.canva.com']);

  it('signs a server certificate that verifies against the CA and names every host', () => {
    const ca = new crypto.X509Certificate(certs.caPem);
    const leaf = new crypto.X509Certificate(certs.certPem);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.checkHost('api.telegram.org')).toBe('api.telegram.org');
    expect(leaf.checkHost('export-download.canva.com')).toBe('export-download.canva.com');
    expect(leaf.checkHost('api.example.com')).toBeUndefined();
  });

  it('is accepted by a Node TLS client that trusts the CA, and refused for a host it does not name', async () => {
    const server = https.createServer({ cert: certs.certPem, key: certs.keyPem }, (_req, res) => res.end('fake'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(get(port, 'api.telegram.org', certs.caPem)).resolves.toBe('fake');
      await expect(get(port, 'api.example.com', certs.caPem)).rejects.toThrow(/altnames|hostname/i);
      // Without the CA the same server is not trusted: nothing outside the chaos project believes it.
      await expect(get(port, 'api.telegram.org', makeChaosCertificates().caPem)).rejects.toThrow(/certificate/i);
    } finally {
      server.close();
    }
  });
});
