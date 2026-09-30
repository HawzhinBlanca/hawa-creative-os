import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('updates the canonical target atomically and records a value-free pending deployment audit', () => {
  const directory=mkdtempSync(join(tmpdir(),'hawa-provider-update-'));
  try {
    const canonical=join(directory,'canonical.env'),link=join(directory,'release.env'),input=join(directory,'input'),audit=join(directory,'audit');
    mkdirSync(input);writeFileSync(canonical,'OPENAI_API_KEY=old_synthetic_secret\nTELEGRAM_BOT_TOKEN=unchanged_synthetic_bot\n');
    symlinkSync(canonical,link);writeFileSync(join(input,'OPENAI_API_KEY'),'new_synthetic_secret\n');
    const args=[resolve('infra/ops/update_provider_credentials.py'),'--env-file',link,'--input-dir',input,'--audit-dir',audit,
      '--reason','Approved host configuration update','--actor','synthetic-host-operator','OPENAI_API_KEY'];
    const result=spawnSync('python3',args,{encoding:'utf8'});expect(result.status,result.stderr).toBe(0);
    expect(readFileSync(canonical,'utf8')).toContain('OPENAI_API_KEY=new_synthetic_secret');
    expect(readFileSync(link,'utf8')).toContain('TELEGRAM_BOT_TOKEN=unchanged_synthetic_bot');
    const receiptPath=join(audit,readdirSync(audit)[0]),serialized=readFileSync(receiptPath,'utf8'),receipt=JSON.parse(serialized);
    expect(receipt).toMatchObject({status:'pending_deployment',changedFields:['OPENAI_API_KEY'],actorType:'host_operator',reason:'Approved host configuration update'});
    expect(receipt.beforeSha256).not.toBe(receipt.afterSha256);
    expect(serialized+result.stdout+result.stderr).not.toContain('synthetic_secret');
    expect(statSync(canonical).mode & 0o777).toBe(0o600);expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
    const before=readFileSync(canonical,'utf8');
    writeFileSync(join(input,'OPENAI_API_KEY'),'bad\nHAWA_ADMIN_KEY=injection\n');
    expect(spawnSync('python3',args).status).not.toBe(0);
    expect(readFileSync(canonical,'utf8')).toBe(before);
    expect(readdirSync(audit)).toHaveLength(1);
    expect(spawnSync('python3',[...args.slice(0,-1),'HAWA_ADMIN_KEY']).status).not.toBe(0);
    expect(readFileSync(canonical,'utf8')).toBe(before);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
