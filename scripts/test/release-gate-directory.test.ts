import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
it('runs stage commands in the gate release when invoked from another checkout',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hawa-exact-gate-')),release=join(dir,'release'),caller=join(dir,'source-checkout'),bin=join(dir,'bin'),record=join(dir,'stage-cwd');
 try{
  for(const path of [join(release,'scripts'),join(release,'infra/ops'),caller,bin])mkdirSync(path,{recursive:true});
  copyFileSync(resolve('scripts/enforce_release_gate.sh'),join(release,'scripts/enforce_release_gate.sh'));
  copyFileSync(resolve('infra/ops/host_lib.sh'),join(release,'infra/ops/host_lib.sh'));
  writeFileSync(join(bin,'git'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  // Stop at stage1: the fixture does not contact a DB or run any later release mutation.
  writeFileSync(join(bin,'pnpm'),'#!/bin/sh\nprintf "%s" "$PWD" > "$STAGE_CWD"\nexit 17\n',{mode:0o700});
  const result=spawnSync('/bin/bash',[join(release,'scripts/enforce_release_gate.sh')],{cwd:caller,encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,STAGE_CWD:record}});
  expect(result.status).toBe(17);
  expect(readFileSync(record,'utf8')).toBe(release);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
