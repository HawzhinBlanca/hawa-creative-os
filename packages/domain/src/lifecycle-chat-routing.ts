/** Choose a request for an unstructured chat reply without trusting a per-chat pointer. */
export interface WaitingChatRequest { requestId: string; rev: number }
export interface LinkedChatReply { requestId: string; rev: number }

export type ChatRequestChoice =
  | { kind: 'target'; requestId: string }
  | { kind: 'none' | 'ambiguous' | 'stale_reply' };

export function chooseWaitingChatRequest(
  waiting: readonly WaitingChatRequest[],
  linkedReply?: LinkedChatReply,
): ChatRequestChoice {
  if (linkedReply) {
    const matched = waiting.find((request) =>
      request.requestId === linkedReply.requestId && request.rev === linkedReply.rev);
    return matched ? { kind: 'target', requestId: matched.requestId } : { kind: 'stale_reply' };
  }
  if (waiting.length === 0) return { kind: 'none' };
  if (waiting.length > 1) return { kind: 'ambiguous' };
  return { kind: 'target', requestId: waiting[0].requestId };
}
