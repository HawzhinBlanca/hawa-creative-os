/** Reproducible pure-geometry microbenchmark; no providers or whole-pipeline SLA claim. */
import {performance} from 'node:perf_hooks';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {packPhotoSequence} from '../../packages/creative/dist/studio/art-direction/photo-packing.js';
const cases=[];
for(const count of [2,6,10])for(const regionCount of [0,32,128]) {
 const photos=Array.from({length:count},(_,photoIndex)=>({photoIndex,width:photoIndex%2?1600:1800,height:1200,regionStatus:'measured',
  regions:Array.from({length:regionCount},(_,r)=>({kind:'face',x:.2+(r%8)*.05,y:.2+Math.floor(r/8)*.025,width:.02,height:.02}))}));
 const area={x:0,y:0,width:1920,height:1080},samples=[];let accepted=0;
 const expected=JSON.stringify(packPhotoSequence(photos,area,15,1080));
 for(let i=0;i<100;i++){const start=performance.now(),result=packPhotoSequence(photos,area,15,1080);samples.push(performance.now()-start);if(result)accepted++;if(JSON.stringify(result)!==expected)throw new Error('Non-deterministic packing');}
 samples.sort((a,b)=>a-b);cases.push({count,regionCount,iterations:100,accepted,p50Ms:samples[49],p95Ms:samples[94],maxMs:samples[99]});
}
const proof={date:'2026-09-30',node:process.version,implementation:'bounded contiguous row partitions <=130, max10 source photos; 128 region input bound',
 cases,providerCalls:0,qualification:'Local geometry microbenchmark, not whole-pipeline SLA; machine load/warm-up affects timings'};
writeFileSync(resolve(process.argv[2]||'/tmp/hawa-topology-packing-benchmark.json'),JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify({cases:cases.length,worstP95Ms:Math.max(...cases.map(c=>c.p95Ms)),deterministic:true}));
