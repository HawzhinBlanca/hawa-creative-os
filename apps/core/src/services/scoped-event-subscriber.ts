import type { StreamEvent } from './stream-event-authority.js';

export const MAX_PENDING_STREAM_EVENTS = 64;

/** One ordered, bounded disclosure queue per live stream; no event outlives a failed subscription. */
export function createScopedEventSubscriber(options: {
  authorize: (event: StreamEvent) => Promise<boolean>;
  write: (event: StreamEvent) => Promise<void>;
  close: () => void;
}) {
  let closed = false;
  let pending = 0;
  let tail = Promise.resolve();
  const stop = () => {
    if (closed) return;
    closed = true;
    options.close();
  };
  const receive = (event: StreamEvent) => {
    if (closed) return;
    if (pending >= MAX_PENDING_STREAM_EVENTS) return stop();
    pending++;
    tail = tail.then(async () => {
      try {
        if (closed) return;
        const allowed = await options.authorize(event);
        if (!closed && allowed) await options.write(event);
      } catch {
        stop();
      } finally {
        pending--;
      }
    });
  };
  return { receive, stop, drained: () => tail };
}
