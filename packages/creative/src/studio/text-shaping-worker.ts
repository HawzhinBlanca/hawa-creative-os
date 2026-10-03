import { parentPort } from 'node:worker_threads';
import { runTextShapingJob, type TextShapingJob } from './text-shaping-job.js';

/**
 * ADR-290 addendum: the worker thread of `TextShapingPool`. One job at a time; a job that throws is
 * answered with its message (the caller records it as not measured, as it did in-process). The font
 * caches of `export-text-shaping.ts` live here, warm across jobs, one shaping and one outline instance
 * per face as on the main thread.
 */
parentPort!.on('message', (message: { id: number; job: TextShapingJob }) => {
  let reply: { id: number; ok: true; result: unknown } | { id: number; ok: false; message: string };
  try {
    reply = { id: message.id, ok: true, result: runTextShapingJob(message.job) };
  } catch (err) {
    reply = { id: message.id, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  parentPort!.postMessage(reply);
});
