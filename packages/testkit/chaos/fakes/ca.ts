/**
 * A throwaway certificate authority and one server certificate, made with node:crypto alone.
 *
 * Core and the workers call providers at addresses written into the code (api.telegram.org,
 * api.openai.com, export-download.canva.com …; PHASE2_DESIGN.md finding 1.2.4–5). The chaos compose
 * project makes those names network aliases of the fakes container and gives Node this CA
 * (NODE_EXTRA_CA_CERTS), so the real URL code runs unchanged and reaches the fakes over real TLS.
 * Node can read certificates but not write them, and the images carry no openssl, so the few DER
 * structures a certificate needs are encoded here. The keys never leave the fakes container.
 */
import crypto from 'node:crypto';

/** The provider hosts the code base calls at fixed addresses, plus Canva's export download hosts. */
export const FAKED_HOSTS = [
  'api.telegram.org',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.anthropic.com',
  'api.canva.com',
  'export-download.canva.com',
  'document-export.canva.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'sheets.googleapis.com',
];

export interface ChaosCertificates {
  caPem: string;
  certPem: string;
  keyPem: string;
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const octets = (value: Buffer) => tlv(0x04, value);
const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
/** A context-specific tag: [n] constructed (explicit) or primitive (implicit). */
const tagged = (n: number, constructed: boolean, ...parts: Buffer[]) => tlv((constructed ? 0xa0 : 0x80) | n, ...parts);
function unsignedInteger(value: Buffer): Buffer {
  let v = value;
  while (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)) v = v.subarray(1);
  return tlv(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}
function bitString(value: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.from([unusedBits]), value);
}
function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let v = part >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
/** UTCTime, which X.509 requires for dates before 2050. */
function utcTime(date: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const text = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}
const commonName = (cn: string) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));
const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

/** The key identifier RFC 5280 suggests: SHA-1 of the public key bits. */
function keyIdentifier(publicKey: crypto.KeyObject): Buffer {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // The public key is the last 65 bytes of a P-256 SubjectPublicKeyInfo (uncompressed point).
  return crypto.createHash('sha1').update(spki.subarray(spki.length - 65)).digest();
}

function toPem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function certificate(options: {
  subject: string;
  issuer: string;
  subjectKey: crypto.KeyObject;
  issuerKey: crypto.KeyObject;
  issuerPublic: crypto.KeyObject;
  extensions: Buffer[];
  days: number;
}): Buffer {
  const now = Date.now();
  const tbs = seq(
    tagged(0, true, unsignedInteger(Buffer.from([2]))),
    unsignedInteger(crypto.randomBytes(16)),
    ECDSA_SHA256,
    commonName(options.issuer),
    seq(utcTime(new Date(now - 60 * 60 * 1000)), utcTime(new Date(now + options.days * 86400 * 1000))),
    commonName(options.subject),
    options.subjectKey.export({ type: 'spki', format: 'der' }),
    tagged(3, true, seq(
      extension('2.5.29.14', false, octets(keyIdentifier(options.subjectKey))),
      extension('2.5.29.35', false, seq(tagged(0, false, keyIdentifier(options.issuerPublic)))),
      ...options.extensions,
    )),
  );
  const signature = crypto.sign('sha256', tbs, options.issuerKey);
  return seq(tbs, ECDSA_SHA256, bitString(signature));
}

/** A CA and a certificate for `hosts` it signed, valid for a week: each new chaos project makes its own. */
export function makeChaosCertificates(hosts: string[] = FAKED_HOSTS): ChaosCertificates {
  const ca = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leaf = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caName = 'Hawa chaos suite test CA (never trust outside hawa-chaos)';
  const caDer = certificate({
    subject: caName,
    issuer: caName,
    subjectKey: ca.publicKey,
    issuerKey: ca.privateKey,
    issuerPublic: ca.publicKey,
    days: 7,
    extensions: [
      extension('2.5.29.19', true, seq(bool(true))),
      // keyCertSign and cRLSign: bits 5 and 6.
      extension('2.5.29.15', true, bitString(Buffer.from([0x06]), 1)),
    ],
  });
  const leafDer = certificate({
    subject: hosts[0],
    issuer: caName,
    subjectKey: leaf.publicKey,
    issuerKey: ca.privateKey,
    issuerPublic: ca.publicKey,
    days: 7,
    extensions: [
      extension('2.5.29.19', true, seq()),
      // digitalSignature: bit 0.
      extension('2.5.29.15', true, bitString(Buffer.from([0x80]), 7)),
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      extension('2.5.29.17', false, seq(...hosts.map((h) => tagged(2, false, Buffer.from(h, 'ascii'))))),
    ],
  });
  return {
    caPem: toPem('CERTIFICATE', caDer),
    certPem: toPem('CERTIFICATE', leafDer),
    keyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
