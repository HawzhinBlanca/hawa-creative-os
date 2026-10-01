import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

function control(mode: string) {
  const directory=mkdtempSync(join(tmpdir(),'hawa-nginx-admission-'));
  const log=join(directory,'calls'), restarted=join(directory,'restarted'), fake=join(directory,'compose');
  writeFileSync(fake,`#!/bin/bash
printf '%s\\n' "$*" >> "$CALL_LOG"
if [[ "$*" == *'restart nginx'* ]]; then
  [[ "$CONTROL_MODE" != restart_failed ]] || exit 1
  touch "$RESTARTED"; exit 0
fi
if [[ "$*" == *'--force-recreate nginx'* ]]; then
  [[ "$CONTROL_MODE" == pinned_until_recreate ]] && CONTROL_MODE=ok && touch "$RESTARTED.recreated"; exit 0
fi
[[ -e "$RESTARTED.recreated" ]] && CONTROL_MODE=ok
if [[ "$*" == *sha256sum* ]]; then
  if [[ "$*" == *hawa-office-proof.conf* ]]; then
    if [[ "$CONTROL_MODE" == stale_proof || "$CONTROL_MODE" == restart_failed || "$CONTROL_MODE" == stale_after_restart || "$CONTROL_MODE" == pinned_until_recreate ]]; then
      [[ "$CONTROL_MODE" == pinned_until_recreate ]] && { echo 'old  file'; exit 0; }
      if [[ ! -e "$RESTARTED" || "$CONTROL_MODE" == stale_after_restart ]]; then echo 'old  file'; exit 0; fi
    fi
    echo 'proof  file'
  else echo 'config  file'; fi
elif [[ "$*" == *'nginx -t'* ]]; then
  [[ "$CONTROL_MODE" != invalid ]] || exit 1
  if [[ "$CONTROL_MODE" == deleted && ! -e "$RESTARTED" ]]; then exit 1; fi
elif [[ "$*" == *'nginx -s reload'* ]]; then
  [[ "$CONTROL_MODE" != reload_failed ]] || exit 1
fi
`,{mode:0o700});
  try {
    const result=spawnSync('/bin/bash',['-c','set -Eeuo pipefail; COMPOSE=("$FAKE"); INTERP_FILE=unused; NGINX_WANT=config; OFFICE_PROOF_WANT=proof; source "$LIB"; hawa_nginx_reload'],{
      encoding:'utf8',env:{...process.env,FAKE:fake,LIB:resolve('infra/ops/nginx_reload.sh'),CONTROL_MODE:mode,CALL_LOG:log,RESTARTED:restarted},
    });
    return {status:result.status,calls:readFileSync(log,'utf8'),error:result.stderr};
  } finally {rmSync(directory,{recursive:true,force:true});}
}
it('validates both live mounts and nginx before and after checked reload',()=>{
  const result=control('ok'); expect(result.status,result.error).toBe(0);
  expect(result.calls).toContain('sha256sum /etc/nginx/hawa-office-proof.conf');
  expect(result.calls.match(/nginx -t/g)?.length).toBe(3);
  expect(result.calls).toContain('nginx -s reload');
  expect(result.calls).not.toContain('restart nginx');
});
it.each(['stale_proof','deleted'])('rebinds %s then validates before reload',(mode)=>{
  const result=control(mode); expect(result.status,result.error).toBe(0);
  expect(result.calls).toContain('restart nginx'); expect(result.calls).toContain('nginx -s reload');
});
it.each(['restart_failed','stale_after_restart','invalid','reload_failed'])('rejects %s instead of reporting deployment success',(mode)=>{
  const result=control(mode); expect(result.status).not.toBe(0);
  if(mode!=='reload_failed') expect(result.calls).not.toContain('nginx -s reload');
});
it('recreates nginx when a restart keeps the pinned mount (ADR-158 addendum 3), then validates and reloads',()=>{
  const result=control('pinned_until_recreate'); expect(result.status,result.error).toBe(0);
  expect(result.calls).toContain('restart nginx');
  expect(result.calls).toContain('up -d --no-deps --force-recreate nginx');
  expect(result.calls).toContain('nginx -s reload');
});
