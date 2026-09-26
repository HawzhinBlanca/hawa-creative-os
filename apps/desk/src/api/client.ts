/**
 * Hawa Desk Typed API Client
 *
 * Interacts exclusively with deployed reverse-proxy routes (/v1/...)
 * using authenticated sessions. No hardcoded development bearer fallbacks.
 */

import { getAuthToken, setAuthToken, clearAuthToken } from '../services/auth.js';

export interface ApiSessionUser {
  id: string;
  role: 'administrator' | 'art_director' | 'creative_director' | 'operator' | string;
  displayName: string;
}

export interface ApiSessionResponse {
  authenticated: boolean;
  token?: string;
  user?: ApiSessionUser;
  tenantId?: string;
}

export interface ApiProblemDetails {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

export class ApiError extends Error {
  public status: number;
  public problem?: ApiProblemDetails;

  constructor(status: number, message: string, problem?: ApiProblemDetails) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }
}

export interface TaskListParams {
  status?: string;
  /** Any of these statuses (a queue filter). An empty list matches nothing. */
  statuses?: readonly string[];
  /** Text to find in the title, description, client name or id. */
  q?: string;
  clientId?: string;
  limit?: number;
  offset?: number;
  /** The page after the one whose `nextCursor` this is. */
  cursor?: string | null;
}

export interface TaskListResponse<T = any> {
  items: T[];
  /** Every task the filter matches, not only this page. */
  total: number;
  limit?: number;
  offset?: number;
  /** The next (older) page, or null on the last one. */
  nextCursor?: string | null;
}

export interface DecisionPayload {
  action: 'approve' | 'revision_requested' | 'reject' | 'escalate';
  reason?: string;
  rejectionCategory?: 'concept' | 'content' | 'brand_direction' | 'task';
  expectedTaskVersion?: number;
  capturedArtifactSetHash?: string;
  qcReportHash?: string;
  /** Stored Canva export ids this approval pins; delivery sends exactly these files. */
  pinnedExportIds?: string[];
  /** Reviewer inspected the selected final PNG where Canva's PPTX has no readable RTL flag. */
  rtlVisualReview?: { confirmed: true; exportSha256: string };
  revisionRequest?: {
    scope?: 'full_design' | 'typography' | 'layout' | 'color' | 'assets' | 'copy';
    category?: 'factual_error' | 'brand_violation' | 'aesthetic_preference' | 'legal_compliance' | 'technical_defect';
    targetNodes?: string[];
    priority?: 'low' | 'medium' | 'high' | 'critical';
    isReusableFeedback?: boolean;
    comment?: string;
  };
}

/** An entry of GET /tasks/:taskId/timeline: a task_events row, or an in-memory transition. */
export interface TaskTimelineEvent {
  eventId?: string;
  eventType?: string;
  aggregateVersion?: number;
  actor?: { type?: string; id?: string | null; displayName?: string };
  data?: unknown;
  fromStatus?: string;
  toStatus?: string;
  reason?: string;
  occurredAt?: string;
}

export interface RequesterSendStep {
  sendKey: string;
  outcome: 'not_attempted' | 'attempted' | 'sent' | 'uncertain' | 'failed' | 'released';
  attemptCount: number;
  lastMarkAt: string | null;
  messageId: string | null;
}

export interface RequesterSendEvidence {
  taskId: string;
  requestId: string;
  requestRev: number;
  publicationId: string;
  approvalId: string;
  requesterChatId: string | null;
  providerReceipt: 'not_available';
  files: Array<RequesterSendStep & { artifactId: string; filename: string; sha256: string }>;
  notice: RequesterSendStep;
}

/** A one-use ticket that opens the event stream (Core: POST /auth/stream-ticket, ADR-037). */
export interface StreamTicket {
  ticket: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

class HawaApiClient {
  private basePrefix = '/v1';
  private unauthorizedHint: ((error: ApiError) => void) | null = null;

  private getHeaders(customHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };
    const token = getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.basePrefix}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const headers = this.getHeaders(options.headers as Record<string, string>);

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
      });
    } catch (networkErr: any) {
      throw new ApiError(0, `Network error: ${networkErr.message || 'Unable to connect to server'}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json') || contentType.includes('application/problem+json');

    if (!response.ok) {
      let problem: ApiProblemDetails | undefined;
      let errorMsg = `Request failed with status ${response.status}`;

      if (isJson) {
        try {
          problem = await response.json();
          // Adapter routes answer { ok: false, description | error } rather than a problem document.
          const body = problem as any;
          errorMsg = problem?.detail || problem?.title || body?.description || body?.error || errorMsg;
        } catch {}
      } else {
        try {
          const text = await response.text();
          if (text) errorMsg = text.slice(0, 300);
        } catch {}
      }

      const error = new ApiError(response.status, errorMsg, problem);
      // A 401 may mean the session ended (expired after 24 hours or revoked). The Desk signs out in one
      // place only, the query cache's error handler (services/queryClient.ts, ADR-037); a call made
      // outside a query (a panel's action, a screen not yet on the query layer) only tells it to check
      // the session now. The sign-in call's own 401 is a wrong key, which the sign-in form reports.
      if (response.status === 401 && !(url.endsWith('/auth/session') && (options.method || 'GET') === 'POST')) {
        try {
          this.unauthorizedHint?.(error);
        } catch (err) {
          console.error('Error in the unauthorized hint:', err);
        }
      }

      throw error;
    }

    if (response.status === 204) {
      return null as any;
    }

    if (isJson) {
      return (await response.json()) as T;
    }

    return (await response.text()) as any;
  }

  public readonly auth = {
    getSession: async (): Promise<ApiSessionResponse> => {
      return this.request<ApiSessionResponse>('/auth/session', { method: 'GET' });
    },

    login: async (credentials: {
      token?: string;
      key?: string;
      email?: string;
      role?: string;
      password?: string;
    }): Promise<ApiSessionResponse> => {
      const res = await this.request<ApiSessionResponse>('/auth/session', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      if (res.token) {
        setAuthToken(res.token);
      }
      return res;
    },

    /**
     * Ends the session on the server as well as in this tab. Clearing the token alone left it valid
     * for 24 hours (2026-09-24). The token is cleared first, so a failed call still signs this tab out.
     */
    logout: async (): Promise<void> => {
      const token = getAuthToken();
      clearAuthToken();
      if (!token) return;
      await this.request('/auth/session', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
    },

    /**
     * A ticket for the event stream, asked for with the bearer header. EventSource cannot send a
     * header, and the session token the Desk put in the stream's address instead was written to every
     * access log on the way; a ticket opens one stream, once, within 60 s (ADR-037).
     */
    streamTicket: (): Promise<StreamTicket> => this.request<StreamTicket>('/auth/stream-ticket', { method: 'POST' }),

    /**
     * The one function told of a 401 (see `request`); the Desk sets it once, to a session check. Null
     * clears it.
     */
    setUnauthorizedHint: (hint: ((error: ApiError) => void) | null): void => {
      this.unauthorizedHint = hint;
    },
  };

  // Telegram adapter. Every call goes through the signed-in session; the webhook secret never
  // leaves the server, so the Desk inspects delivery through Core instead of posting to the webhook.
  public readonly telegram = {
    status: () => this.request<any>('/adapters/telegram/status'),
    pollNow: () => this.request<any>('/adapters/telegram/poll-now', { method: 'POST' }),
    webhookInfo: () => this.request<any>('/adapters/telegram/webhook/info'),
    registerWebhook: (url: string) =>
      this.request<any>('/adapters/telegram/webhook/register', { method: 'POST', body: JSON.stringify({ url }) }),
    deleteWebhook: () =>
      this.request<any>('/adapters/telegram/webhook/delete', { method: 'POST', body: JSON.stringify({ dropPendingUpdates: true }) }),
  };

  public readonly system = {
    providers: () => this.request<any>('/system/providers'),
    saveProviders: (keys: Record<string, string>) =>
      this.request<any>('/system/providers', { method: 'POST', body: JSON.stringify(keys) }),
  };

  // Client DNA, snapshots, candidate rules and budgets. Core keeps all of these in memory, so a
  // Core restart discards what is written here.
  public readonly clients = {
    list: () => this.request<any[]>('/clients'),
    dna: (clientId: string) => this.request<any>(`/clients/${encodeURIComponent(clientId)}/dna`),
    saveDna: (clientId: string, dna: unknown) =>
      this.request<any>(`/clients/${encodeURIComponent(clientId)}/dna`, { method: 'POST', body: JSON.stringify(dna) }),
    snapshots: (clientId: string) => this.request<any[]>(`/clients/${encodeURIComponent(clientId)}/snapshots`),
    commitSnapshot: (clientId: string, body: { commitMessage: string; createdBy: string }) =>
      this.request<any>(`/clients/${encodeURIComponent(clientId)}/snapshots`, { method: 'POST', body: JSON.stringify(body) }),
    candidateRules: (clientId: string) => this.request<any>(`/clients/${encodeURIComponent(clientId)}/candidate-rules`),
    // No role in the body: Core takes the role from the signed-in session.
    promoteCandidate: (clientId: string, ruleId: string) =>
      this.request<any>(
        `/clients/${encodeURIComponent(clientId)}/candidate-rules/${encodeURIComponent(ruleId)}/promote`,
        { method: 'POST', body: JSON.stringify({}) }
      ),
    dismissCandidate: (clientId: string, ruleId: string, reason: string) =>
      this.request<{ dismissed: boolean }>(
        `/clients/${encodeURIComponent(clientId)}/candidate-rules/${encodeURIComponent(ruleId)}/dismiss`,
        { method: 'POST', body: JSON.stringify({ reason }) }
      ),
    budgets: () => this.request<any>('/clients/budgets'),
    // Core reads `capUsd`; under any other name the cap silently becomes its USD 10 default.
    allocateBudget: (clientId: string, capUsd: number) =>
      this.request<any>(`/clients/${encodeURIComponent(clientId)}/budget/allocate`, {
        method: 'POST',
        body: JSON.stringify({ capUsd }),
      }),
  };

  public readonly operations = {
    integrationsHealth: () => this.request<any>('/integrations/health'),
    funnelHealth: () => this.request<any>('/system/funnel/health'),
    failures: () => this.request<any>('/operations/failures'),
    slo: () => this.request<any>('/operations/slo'),
    reconciliation: () => this.request<any>('/operations/reconciliation'),
    // Audit only. Core refuses auto-repair (422): it cannot upload to Drive or write Sheets.
    auditReconciliation: () =>
      this.request<any>('/operations/reconciliation/run', { method: 'POST', body: JSON.stringify({ autoRepair: false }) }),
  };

  public readonly evaluations = {
    datasets: () => this.request<any[]>('/evaluations/datasets'),
    runs: () => this.request<any[]>('/evaluations/runs'),
    cases: (datasetId: string) => this.request<any>(`/evaluations/datasets/${encodeURIComponent(datasetId)}/cases`),
    run: (name: string) => this.request<any>('/evaluations/runs', { method: 'POST', body: JSON.stringify({ name }) }),
  };

  // The blinded comparison with the office designer (Core: routes/comparison.routes.ts). The judges'
  // own pages are served by Core under /api/judge/ and never go through this client.
  public readonly comparisons = {
    list: () => this.request<{ studies: import('../services/comparison.js').StudySummary[] }>('/comparisons'),
    get: (id: string) => this.request<import('../services/comparison.js').StudyDetail>(`/comparisons/${encodeURIComponent(id)}`),
    create: (body: { name: string; preregistration: import('../services/comparison.js').Preregistration }) =>
      this.request<import('../services/comparison.js').StudySummary>('/comparisons', { method: 'POST', body: JSON.stringify(body) }),
    addPair: (id: string, body: import('../services/comparison.js').AddPairBody) =>
      this.request<import('../services/comparison.js').PairSummary>(`/comparisons/${encodeURIComponent(id)}/pairs`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    addJudge: (id: string, body: { name: string; kind: 'requester' | 'designer' }) =>
      this.request<import('../services/comparison.js').AddedJudge>(`/comparisons/${encodeURIComponent(id)}/judges`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    revokeJudge: (id: string, judgeId: string) =>
      this.request<{ revokedAt: string; already: boolean }>(
        `/comparisons/${encodeURIComponent(id)}/judges/${encodeURIComponent(judgeId)}`,
        { method: 'DELETE' }
      ),
    lock: (id: string) => this.request<import('../services/comparison.js').StudyDetail>(`/comparisons/${encodeURIComponent(id)}/lock`, { method: 'POST' }),
    close: (id: string) => this.request<import('../services/comparison.js').StudyDetail>(`/comparisons/${encodeURIComponent(id)}/close`, { method: 'POST' }),
    results: (id: string) => this.request<import('../services/comparison.js').OfficeResults>(`/comparisons/${encodeURIComponent(id)}/results`),
    /** A new link for a judge who lost theirs, on the same judge record; shown once. */
    reissueLink: (id: string, judgeId: string) =>
      this.request<{ judgeId: string; token: string; link: { path: string; url: string | null } }>(
        `/comparisons/${encodeURIComponent(id)}/judges/${encodeURIComponent(judgeId)}/link`,
        { method: 'POST' }
      ),
    /** One arm's stored PNG, fetched with the session header rather than a token in the address. */
    pairImage: async (id: string, pairId: string, arm: 'hawa' | 'designer'): Promise<Blob> => {
      const response = await fetch(
        `${this.basePrefix}/comparisons/${encodeURIComponent(id)}/pairs/${encodeURIComponent(pairId)}/${arm}.png`,
        { headers: this.getHeaders() }
      );
      if (!response.ok) throw new ApiError(response.status, 'The design could not be loaded');
      return response.blob();
    },
  };

  public readonly fonts = {
    inspect: (body: { fontBase64: string; fontName: string }) =>
      this.request<any>('/fonts/inspect', { method: 'POST', body: JSON.stringify(body) }),
  };

  public readonly canva = {
    status: () => this.request<any>('/integrations/canva/status'),
    disconnect: () => this.request<any>('/integrations/canva/disconnect',{method:'POST'}),
    authorize: () => this.request<{authorizationUrl:string}>('/integrations/canva/authorize',{method:'POST'}),
    taskState: (id:string) => this.request<any>(`/tasks/${encodeURIComponent(id)}/canva`),
    plans: (id:string) => this.request<any>(`/tasks/${encodeURIComponent(id)}/canva/plans`),
    generate: (id:string,width:number,height:number,key:string) => this.request<any>(`/tasks/${encodeURIComponent(id)}/canva/generate`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({width,height})}),
    resumePlan: (id:string,planId:string) => this.request<any>(`/tasks/${encodeURIComponent(id)}/canva/plans/${encodeURIComponent(planId)}/resume`,{method:'POST'}),
    resumeImport: (id:string,operationId:string) => this.request<any>(`/tasks/${encodeURIComponent(id)}/canva/imports/${encodeURIComponent(operationId)}/resume`,{method:'POST'}),
    editor: (id:string) => this.request<{url:string}>(`/tasks/${encodeURIComponent(id)}/canva/editor`),
    create: (id:string,width:number,height:number,key:string) => this.request<any>(`/tasks/${encodeURIComponent(id)}/canva/design`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({width,height})}),
    export: (id:string,format:'png'|'pdf'|'pptx',expectedVersion:number,key:string) => this.request<any>(`/tasks/${encodeURIComponent(id)}/canva/exports`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({format,expectedVersion})}),
    resume: (id:string,operationId:string) => this.request<any>(`/tasks/${encodeURIComponent(id)}/canva/exports/${encodeURIComponent(operationId)}/resume`,{method:'POST'}),
    download: async (id:string,artifactId:string):Promise<Blob> => {
      const response=await fetch(`/v1/tasks/${encodeURIComponent(id)}/canva/artifacts/${encodeURIComponent(artifactId)}`,{headers:this.getHeaders()});
      if(!response.ok) throw new ApiError(response.status,'Export download failed');
      return response.blob();
    },
  };

  public readonly studio = {
    start: (
      taskId: string,
      input: {
        width: number;
        height: number;
        tier?: string;
        imagery?: string;
        previews?: number;
        holdForSelection?: boolean;
      },
      key: string
    ) =>
      this.request<{ runId: string; status: string; created: boolean }>(
        `/tasks/${encodeURIComponent(taskId)}/canva/studio`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify(input),
        }
      ),
    resume: (taskId: string, runId: string) =>
      this.request<any>(
        `/tasks/${encodeURIComponent(taskId)}/canva/studio/${encodeURIComponent(runId)}/resume`,
        {
          method: 'POST',
        }
      ),
    getRun: (taskId: string, runId: string) =>
      this.request<any>(
        `/tasks/${encodeURIComponent(taskId)}/canva/studio/${encodeURIComponent(runId)}`
      ),
    select: (taskId: string, runId: string, candidateId: string) =>
      this.request<any>(
        `/tasks/${encodeURIComponent(taskId)}/canva/studio/${encodeURIComponent(runId)}/select`,
        {
          method: 'POST',
          body: JSON.stringify({ candidateId }),
        }
      ),
    abandon: (taskId: string, runId: string, reason?: string) =>
      this.request<any>(
        `/tasks/${encodeURIComponent(taskId)}/canva/studio/${encodeURIComponent(runId)}/abandon`,
        {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }
      ),
    feedback: (
      taskId: string,
      payload: {
        runId?: string;
        candidateId?: string;
        verdict: 'approve' | 'reject' | 'revise' | 'rating';
        rating?: number;
        notes?: string;
      }
    ) =>
      this.request<any>(`/tasks/${encodeURIComponent(taskId)}/design-feedback`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  };

  public readonly tasks = {
    getEditorUrl: (taskId: string) => this.request<{ url: string }>(`/tasks/${encodeURIComponent(taskId)}/canva/editor`),
    bindCanva: (taskId: string, editUrl: string) => this.request(`/tasks/${encodeURIComponent(taskId)}/canva-binding`, {
      method: 'POST', body: JSON.stringify({ editUrl }),
    }),
    redrive: (taskId: string) => this.request<any>(`/tasks/${encodeURIComponent(taskId)}/redrive`, { method: 'POST' }),
    /** What the requester asked of this design, round by round (Core: GET /tasks/:taskId/asks). */
    asks: (taskId: string) => this.request<{ taskId: string; rounds: import('../components/AskLedger.js').LedgerRound[] }>(`/tasks/${encodeURIComponent(taskId)}/asks`),
    sweepFailed: () => this.request<any>('/tasks/sweep-failed', { method: 'POST' }),
    list: async <T = any>(params?: TaskListParams): Promise<TaskListResponse<T>> => {
      const q = new URLSearchParams();
      if (params?.status) q.set('status', params.status);
      if (params?.statuses) q.set('statuses', params.statuses.join(','));
      if (params?.q) q.set('q', params.q);
      if (params?.clientId) q.set('clientId', params.clientId);
      if (params?.limit !== undefined) q.set('limit', String(params.limit));
      if (params?.offset !== undefined) q.set('offset', String(params.offset));
      if (params?.cursor) q.set('cursor', params.cursor);

      const queryStr = q.toString();
      const endpoint = queryStr ? `/tasks?${queryStr}` : '/tasks';
      return this.request<TaskListResponse<T>>(endpoint, { method: 'GET' });
    },

    get: async <T = any>(taskId: string): Promise<T> => {
      return this.request<T>(`/tasks/${taskId}`, { method: 'GET' });
    },

    /** The task's recorded events, oldest first as Core stores them (History & Audit). */
    timeline: (taskId: string) =>
      this.request<{ events: TaskTimelineEvent[] }>(`/tasks/${encodeURIComponent(taskId)}/timeline`),

    requesterSendEvidence: (taskId: string) =>
      this.request<RequesterSendEvidence>(`/tasks/${encodeURIComponent(taskId)}/requester-send-evidence`),

    confirmRequesterSend: (taskId: string, body: { actionId: string; expectedRev: number;
      publicationId: string; approvalId: string; requesterChatId: string;
      observed: Array<{ sendKey: string; messageId: string }>; attested: true }) =>
      this.request<{ requestId: string; taskId: string; requestRev: number;
        confirmationSource: 'staff_visible'; stage: 'delivered' }>(
        `/tasks/${encodeURIComponent(taskId)}/requester-send-confirmation`,
        { method: 'POST', body: JSON.stringify(body) }),

    create: async <T = any>(body: any): Promise<T> => {
      return this.request<T>('/tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    createRevision: async <T = any>(taskId: string, body: any): Promise<T> => {
      return this.request<T>(`/tasks/${taskId}/revisions`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    runQa: async <T = any>(taskId: string, revisionId: string): Promise<T> => {
      return this.request<T>(`/tasks/${taskId}/revisions/${revisionId}/qa`, {
        method: 'POST',
      });
    },

    recordDecision: async <T = any>(
      taskId: string,
      revisionId: string,
      payload: DecisionPayload,
      actionId?: string
    ): Promise<T> => {
      return this.request<T>(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
        method: 'POST',
        ...(actionId ? { headers: { 'Idempotency-Key': actionId } } : {}),
        body: JSON.stringify(payload),
      });
    },

    publish: async <T = any>(taskId: string, body?: { destination?: string; policy?: string; approvalId?: string }, actionId?: string): Promise<T> => {
      return this.request<T>(`/tasks/${taskId}/publish`, {
        method: 'POST',
        ...(actionId ? { headers: { 'Idempotency-Key': actionId } } : {}),
        body: JSON.stringify(body || {}),
      });
    },
  };
}

export const apiClient = new HawaApiClient();
