import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type RequesterSendStep } from '../api/client.js';

const OUTCOME_WORDS: Record<RequesterSendStep['outcome'], string> = {
  not_attempted: 'No recorded attempt',
  attempted: 'Attempt started; outcome unknown',
  sent: 'Bot API send recorded; requester receipt unknown',
  uncertain: 'May have arrived; requester receipt unknown',
  failed: 'Send failed',
  released: 'Operator released the send for replay',
};

/** Read-only local sender evidence; it never claims the requester opened or received a file. */
export function RequesterSendEvidencePanel({ taskId, canConfirm }: { taskId: string; canConfirm: boolean }) {
  const queryClient = useQueryClient();
  const actionId = useRef<string | null>(null);
  const [observedIds, setObservedIds] = useState<Record<string, string>>({});
  const [attested, setAttested] = useState(false);
  const query = useQuery({
    queryKey: ['requester-send-evidence', taskId],
    queryFn: () => apiClient.tasks.requesterSendEvidence(taskId),
    staleTime: 0,
  });
  const confirmation = useMutation({
    mutationFn: async () => {
      const evidence = query.data;
      if (!evidence?.requesterChatId) throw new Error('The requester chat is unavailable');
      actionId.current ||= crypto.randomUUID();
      const steps = [...evidence.files, evidence.notice];
      return apiClient.tasks.confirmRequesterSend(taskId, {
        actionId: actionId.current, expectedRev: evidence.requestRev,
        publicationId: evidence.publicationId, approvalId: evidence.approvalId,
        requesterChatId: evidence.requesterChatId,
        observed: steps.map((step) => ({ sendKey: step.sendKey,
          messageId: (observedIds[step.sendKey] ?? step.messageId ?? '').trim() })),
        attested: true,
      });
    },
    onSuccess: async () => { await queryClient.invalidateQueries(); },
  });
  const steps = query.data ? [...query.data.files, query.data.notice] : [];
  const canSubmit = canConfirm && Boolean(query.data?.requesterChatId) && attested &&
    steps.length > 1 && steps.every((step) => ['sent', 'attempted', 'uncertain'].includes(step.outcome) &&
      /^[1-9][0-9]*$/.test((observedIds[step.sendKey] ?? step.messageId ?? '').trim())) &&
    !confirmation.isPending;
  return <section aria-label="Telegram delivery evidence" className="requester-send-evidence">
    <h3>Telegram delivery evidence</h3>
    <p>The office must compare these local send records with the requester chat. They are not a requester receipt.</p>
    {query.isPending && <p role="status">Loading send records…</p>}
    {query.isError && <p role="alert">Send records are unavailable. No delivery decision can be made from this screen.</p>}
    {query.data && <>
      <p>Requester chat: <code>{query.data.requesterChatId || 'Not recorded'}</code></p>
      <ul>{query.data.files.map((file) => <li key={file.artifactId}>
        <strong>{file.filename}</strong>: {OUTCOME_WORDS[file.outcome]}.
        {' '}Recorded attempts: {file.attemptCount}.
        {file.messageId && <> Bot API message ID: <code>{file.messageId}</code>.</>}
        {file.lastMarkAt && <> Last mark: <time dateTime={file.lastMarkAt}>{file.lastMarkAt}</time>.</>}
      </li>)}</ul>
      <p>Delivery notice: {OUTCOME_WORDS[query.data.notice.outcome]}.
        {query.data.notice.messageId && <> Bot API message ID: <code>{query.data.notice.messageId}</code>.</>}
      </p>
      <p>Telegram requester receipt: unavailable.</p>
      {canConfirm && <div className="requester-send-confirmation">
        <h4>Staff confirmation from the requester chat</h4>
        <p>Enter the message ID visible in this exact chat for every approved file and the notice. Leave this unresolved if any item cannot be found. This records your inspection, not a requester read receipt.</p>
        {query.data.files.map((file) => <label key={`confirm-${file.artifactId}`}>
          {file.filename} · SHA-256 <code>{file.sha256}</code>
          <input aria-label={`Observed message ID for ${file.filename}`} inputMode="numeric"
            value={observedIds[file.sendKey] ?? file.messageId ?? ''}
            onChange={(event) => { actionId.current = null; setObservedIds((previous) => ({ ...previous,
              [file.sendKey]: event.target.value })); }} />
        </label>)}
        <label>Delivery notice message ID
          <input aria-label="Observed message ID for delivery notice" inputMode="numeric"
            value={observedIds[query.data.notice.sendKey] ?? query.data.notice.messageId ?? ''}
            onChange={(event) => { actionId.current = null; setObservedIds((previous) => ({ ...previous,
              [query.data!.notice.sendKey]: event.target.value })); }} />
        </label>
        <label><input type="checkbox" checked={attested} onChange={(event) => setAttested(event.target.checked)} />
          I compared every approved item and the notice in requester chat {query.data.requesterChatId}.
        </label>
        <button className="btn" type="button" disabled={!canSubmit} onClick={() => void confirmation.mutate()}>
          {confirmation.isPending ? 'Recording confirmation…' : 'Confirm visible in requester chat'}
        </button>
        {confirmation.isError && <p role="alert">Confirmation was not recorded. Check the chat, then retry this same decision.</p>}
        {confirmation.isSuccess && <p role="status">Staff confirmation recorded. Requester read receipt remains unavailable.</p>}
      </div>}
    </>}
    <button className="btn" type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
      Refresh send records
    </button>
  </section>;
}
