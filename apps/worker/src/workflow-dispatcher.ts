import { signCustomerOpenCommand } from './lifecycle/customer-web-entry.js';
import {signCustomerActionCommand} from './lifecycle/customer-web-actions.js';
/**
 * Hawa Creative OS — request-owner dispatch from the outbox.
 * Requirements: FR-004, FR-060, NFR-001, NFR-003
 *
 * Hands an outbox command to its RequestLifecycle through Restate's public ingress and returns the
 * engine's real invocation receipt: a website request (customer.request.open / .action, through
 * ChatInbox) and, since ADR-287, a Desk "New task" (office.request.open, through
 * OfficeDecisionGateway). A repeat after a consumer stopped mid-command is sent under the same
 * idempotency key. The task workflow dispatch (task.created / task.dispatch to TaskWorkflow, with an
 * embedded runner without Restate) was retired by ADR-287: no request is designed outside
 * RequestLifecycle.
 */

import { requestIdHeaders } from './logging.js';
import { signLifecycleOfficeEvent } from '@hawa/integrations';
import type { OutboxCommandRecord } from './outbox-consumer.js';

export interface WorkflowSubmissionReceipt {
  workflowId: string;
  aggregateId: string;
  status: 'submitted' | 'completed';
  idempotencyKey: string;
  submittedAt: string;
  receiptId: string;
  reconciled?: boolean;
}

export interface TaskWorkflowDispatcherOptions {
  restateIngressUrl?: string;
  customerSigningSecret?:string;
  fetcher?:typeof fetch;
}

export class TaskWorkflowDispatcher {
  constructor(private readonly options: TaskWorkflowDispatcherOptions = {}) {}

  /** Virtual-object commands use an actual ingress receipt and a retained action key. */
  async dispatchCustomer(cmd:OutboxCommandRecord):Promise<WorkflowSubmissionReceipt> {
    if(!['customer.request.open','customer.request.action'].includes(cmd.command_type) || cmd.aggregate_type!=='request' ||
      !/^[0-9a-f-]{36}$/i.test(cmd.aggregate_id) || cmd.payload?.v!==1 || cmd.payload.requestId!==cmd.aggregate_id)
      throw new Error('INVALID_CUSTOMER_OPEN_COMMAND');
    if(!this.options.restateIngressUrl) throw new Error('CUSTOMER_LIFECYCLE_INGRESS_NOT_CONFIGURED');
    const action=cmd.command_type==='customer.request.action';
    const refs={v:1 as const,requestId:cmd.aggregate_id,tenantId:cmd.tenant_id,
      accountId:cmd.payload.accountId,commandId:cmd.id,key:cmd.idempotency_key},
      secret=this.options.customerSigningSecret ?? process.env.HAWA_WORKER_TOKEN ?? '';
    const signed=action ? signCustomerActionCommand({...refs,actionId:cmd.payload.actionId},secret) : signCustomerOpenCommand(refs,secret);
    const response=await (this.options.fetcher ?? fetch)(`${this.options.restateIngressUrl}/ChatInbox/web:${signed.accountId}/${action ? 'webAction':'webOpen'}/send`,{
      method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':cmd.idempotency_key,...requestIdHeaders()},
      signal:AbortSignal.timeout(10000),body:JSON.stringify(signed)});
    if(!response.ok) throw new Error(`CUSTOMER_LIFECYCLE_SUBMISSION_FAILED: HTTP ${response.status}`);
    const answer=await response.json().catch(()=>null) as {invocationId?:string}|null;
    const receiptId=answer?.invocationId ?? response.headers.get('x-restate-id');
    if(!/^inv_[A-Za-z0-9_-]+$/.test(receiptId ?? '')) throw new Error('CUSTOMER_LIFECYCLE_RECEIPT_MISSING');
    return {workflowId:cmd.aggregate_id,aggregateId:cmd.aggregate_id,status:'submitted',idempotencyKey:cmd.idempotency_key,
      submittedAt:new Date().toISOString(),receiptId:receiptId!};
  }

  /**
   * ADR-287: a Desk "New task" Core opened (outbox `office.request.open`, aggregate the request). The
   * open event Core wrote is signed with the worker credential and handed to OfficeDecisionGateway, which
   * forwards it to the request's private RequestLifecycle object under `open:<requestId>`. A repeat after
   * a consumer stopped mid-command is answered by Restate under the same idempotency key.
   */
  async dispatchDeskOpen(cmd: OutboxCommandRecord): Promise<WorkflowSubmissionReceipt> {
    const payload = typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : cmd.payload;
    const event = payload?.event;
    if (cmd.command_type !== 'office.request.open' || cmd.aggregate_type !== 'request' ||
        !/^[0-9a-f-]{36}$/i.test(cmd.aggregate_id) || payload?.v !== 1 || payload.requestId !== cmd.aggregate_id ||
        !event || event.requestId !== cmd.aggregate_id || event.tenantId !== cmd.tenant_id)
      throw new Error('INVALID_DESK_OPEN_COMMAND');
    if (!this.options.restateIngressUrl) throw new Error('DESK_LIFECYCLE_INGRESS_NOT_CONFIGURED');
    const secret = this.options.customerSigningSecret ?? process.env.HAWA_WORKER_TOKEN ?? '';
    const response = await (this.options.fetcher ?? fetch)(`${this.options.restateIngressUrl}/OfficeDecisionGateway/openDeskRequest/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': cmd.idempotency_key, ...requestIdHeaders() },
      signal: AbortSignal.timeout(10000), body: JSON.stringify({ v: 1, event, signature: signLifecycleOfficeEvent(secret, event) }) });
    if (!response.ok) throw new Error(`DESK_LIFECYCLE_SUBMISSION_FAILED: HTTP ${response.status}`);
    const answer = await response.json().catch(() => null) as { invocationId?: string } | null;
    const receiptId = answer?.invocationId ?? response.headers.get('x-restate-id');
    if (!/^inv_[A-Za-z0-9_-]+$/.test(receiptId ?? '')) throw new Error('DESK_LIFECYCLE_RECEIPT_MISSING');
    return { workflowId: cmd.aggregate_id, aggregateId: cmd.aggregate_id, status: 'submitted', idempotencyKey: cmd.idempotency_key,
      submittedAt: new Date().toISOString(), receiptId: receiptId! };
  }
}
