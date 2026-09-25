import { useQuery } from '@tanstack/react-query';
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
export function RequesterSendEvidencePanel({ taskId }: { taskId: string }) {
  const query = useQuery({
    queryKey: ['requester-send-evidence', taskId],
    queryFn: () => apiClient.tasks.requesterSendEvidence(taskId),
    staleTime: 0,
  });
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
        {file.lastMarkAt && <> Last mark: <time dateTime={file.lastMarkAt}>{file.lastMarkAt}</time>.</>}
      </li>)}</ul>
      <p>Delivery notice: {OUTCOME_WORDS[query.data.notice.outcome]}.</p>
      <p>Telegram requester receipt: unavailable.</p>
    </>}
    <button className="btn" type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
      Refresh send records
    </button>
  </section>;
}
