import type { Hono } from 'hono';
import type { ClientDNA } from '@hawa/domain';
import type { CoreContext } from '../core-context.js';

export interface ClientDnaSnapshot {
  snapshotId: string;
  clientId: string;
  version: number;
  sha256: string;
  commitMessage: string;
  createdBy: string;
  createdAt: string;
  dna: ClientDNA;
}

export type RouteRegistrar = (method: 'get' | 'post' | 'put' | 'delete', path: string, handler: any) => void;

export interface AuthContext {
  authenticated: boolean;
  role?: string;
  tenantId?: string;
  actorId?: string;
  userId?: string;
}

/** What a route module receives: the shared context (core-context.ts) plus the app to register on. */
export interface RouteContext extends CoreContext {
  app: Hono;
  registerRoute: RouteRegistrar;
}
