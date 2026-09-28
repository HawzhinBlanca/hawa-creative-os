import {execFileSync} from 'node:child_process';
import {mkdirSync,renameSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const target=path.resolve(here,'../bin/text-measure');
mkdirSync(path.dirname(target),{recursive:true});
const flags=execFileSync('pkg-config',['--cflags','--libs','pangocairo','pangoft2'],{encoding:'utf8'}).trim().split(/\s+/);
const temp=`${target}.${process.pid}`;
try {
  execFileSync(process.env.CC || 'cc',['-std=c11','-O2','-Wall','-Wextra','-Werror',path.join(here,'text-measure.c'),'-o',temp,...flags,'-lm'],{stdio:'inherit'});
  execFileSync(temp,['--identity'],{stdio:'inherit'});
  renameSync(temp,target);
} finally { rmSync(temp,{force:true}); }
