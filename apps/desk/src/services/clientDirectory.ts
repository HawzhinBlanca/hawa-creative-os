import { apiClient } from '../api/client.js';

export interface ClientSummary {
  clientId: string;
  name: string;
  code: string;
  version: number;
  status: 'active' | 'archived' | 'draft';
  defaultLocale: string;
  defaultDirection?: 'rtl' | 'ltr';
  colorsCount: number;
  rulesCount: number;
  snapshotsCount?: number;
  updatedAt?: string;
}

/** A failed/malformed directory must not silently become a known empty list. */
export async function readClientDirectory(): Promise<ClientSummary[]> {
  const data: unknown = await apiClient.clients.list();
  if (!Array.isArray(data) || data.some(row => !row || typeof row !== 'object' ||
      typeof row.clientId !== 'string' || !row.clientId || typeof row.name !== 'string' ||
      typeof row.code !== 'string' || typeof row.defaultLocale !== 'string' || typeof row.status !== 'string')) {
    throw new Error('Core returned an invalid client directory');
  }
  return (data as ClientSummary[]).filter(client => client.status === 'active');
}
