import type { Issue, OrderBlockDto } from '@trendpilot/domain';

export interface ApiFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  issues: Issue[];
}
export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

/** Browser client for /v1. The session cookie is sent automatically (same origin). */
export async function request<T>(method: string, path: string, opts: { body?: unknown; revision?: number; redirectOn401?: boolean } = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.revision !== undefined) headers['if-match'] = `"${opts.revision}"`;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: 'no-store' });
  } catch {
    return { ok: false, status: 0, code: 'NETWORK', message: 'Could not reach the server. Check your connection and try again.', issues: [] };
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (res.ok) return { ok: true, data: body as T };
  if (res.status === 401 && opts.redirectOn401 !== false) window.location.assign('/sign-in');
  return { ok: false, status: res.status, code: body?.code ?? 'UNKNOWN', message: body?.message ?? 'Request failed.', issues: body?.issues ?? [] };
}

export const api = {
  createBlock: (body: unknown) => request<OrderBlockDto>('POST', '/v1/me/order-blocks', { body }),
  updateBlock: (id: string, revision: number, body: unknown) => request<OrderBlockDto>('PATCH', `/v1/me/order-blocks/${id}`, { body, revision }),
  pauseBlock: (id: string, revision: number) => request<OrderBlockDto>('POST', `/v1/me/order-blocks/${id}/pause`, { revision }),
  resumeBlock: (id: string, revision: number) => request<OrderBlockDto>('POST', `/v1/me/order-blocks/${id}/resume`, { revision }),
  previewDraft: <T>(body: unknown) => request<T>('POST', '/v1/me/order-blocks/preview', { body })
};

/** First message per field path, for inline errors. */
export function issueMap(issues: Issue[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const i of issues) m[i.path] ??= i.message;
  return m;
}
