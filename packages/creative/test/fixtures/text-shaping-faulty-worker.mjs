// A worker for TextShapingPool's failure tests (ADR-290 addendum). The first copy string picks the fault:
// 'exit' ends the thread, 'throw' throws outside the message handler, 'hang' spins until terminated,
// anything else answers at once.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, job }) => {
  const mode = job.copyText?.[0];
  if (mode === 'exit') process.exit(3);
  if (mode === 'throw') {
    setImmediate(() => { throw new Error('the fixture worker crashed'); });
    return;
  }
  if (mode === 'hang') {
    for (;;) { /* until terminated */ }
  }
  parentPort.postMessage({ id, ok: true, result: { measured: false, reason: `fixture answered ${mode}` } });
});
