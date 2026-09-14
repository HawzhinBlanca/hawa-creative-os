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
  clientId?: string;
  limit?: number;
  offset?: number;
}

export interface TaskListResponse<T = any> {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
}

export interface DecisionPayload {
  action: 'approve' | 'revision_requested' | 'reject' | 'escalate';
  reason?: string;
  expectedTaskVersion?: number;
  capturedArtifactSetHash?: string;
  qcReportHash?: string;
  revisionRequest?: {
    scope?: string;
    category?: string;
    comment?: string;
  };
}

class HawaApiClient {
  private basePrefix = '/v1';

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
          errorMsg = problem?.detail || problem?.title || errorMsg;
        } catch {}
      } else {
        try {
          const text = await response.text();
          if (text) errorMsg = text.slice(0, 300);
        } catch {}
      }

      throw new ApiError(response.status, errorMsg, problem);
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

    logout: (): void => {
      clearAuthToken();
    },
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
    list: async <T = any>(params?: TaskListParams): Promise<TaskListResponse<T>> => {
      const q = new URLSearchParams();
      if (params?.status) q.set('status', params.status);
      if (params?.clientId) q.set('clientId', params.clientId);
      if (params?.limit !== undefined) q.set('limit', String(params.limit));
      if (params?.offset !== undefined) q.set('offset', String(params.offset));

      const queryStr = q.toString();
      const endpoint = queryStr ? `/tasks?${queryStr}` : '/tasks';
      return this.request<TaskListResponse<T>>(endpoint, { method: 'GET' });
    },

    get: async <T = any>(taskId: string): Promise<T> => {
      return this.request<T>(`/tasks/${taskId}`, { method: 'GET' });
    },

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
      payload: DecisionPayload
    ): Promise<T> => {
      return this.request<T>(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    publish: async <T = any>(taskId: string, body?: { destination?: string; policy?: string }): Promise<T> => {
      return this.request<T>(`/tasks/${taskId}/publish`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
      });
    },
  };
}

export const apiClient = new HawaApiClient();
