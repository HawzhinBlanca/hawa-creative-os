import { constants, openSync, fchmodSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';

/** A private disposable proof include. In-place writes keep a running bind mount readable. */
export function writeOfficeProofInclude(path: string, proof: string): void {
  if (!/^[a-f0-9]{64}$/.test(proof)) throw new Error('Invalid disposable office proof');
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `proxy_set_header X-Hawa-Office-Proof "${proof}";\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
