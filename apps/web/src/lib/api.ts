'use client';

import type { ZodType } from 'zod';
import { API_URL } from './env';
import { useAuthStore } from './auth-store';
import { refreshSession } from './session';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type AuthMode = 'access' | 'enrollment' | 'none';

interface ApiOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  schema?: ZodType<T>;
  auth?: AuthMode;
  headers?: Record<string, string>;
}

/** Extracts a human-readable message from NestJS / RFC 7807 error bodies. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const b = body as { message?: unknown; detail?: unknown; errors?: Array<{ field?: string; message?: string }> };
      if (Array.isArray(b.errors) && b.errors.length > 0) {
        return b.errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join('; ');
      }
      if (typeof b.message === 'string') return b.message;
      if (Array.isArray(b.message)) return b.message.join('; ');
      if (typeof b.detail === 'string') return b.detail;
    }
  } catch {
    // fall through
  }
  if (res.status === 429) return 'Too many requests. Please wait a moment and try again.';
  return `Request failed (${res.status})`;
}

function bearer(mode: AuthMode): string | null {
  const s = useAuthStore.getState();
  if (mode === 'access') return s.accessToken;
  if (mode === 'enrollment') return s.enrollmentToken ?? s.accessToken;
  return null;
}

/**
 * fetch wrapper for apps/api. Sends the in-memory access token as a Bearer header (never a
 * cookie), validates the JSON response with Zod and, on a 401, refreshes once via the
 * httpOnly cookie and retries.
 */
async function request<T>(path: string, opts: ApiOptions<T>, accept: string): Promise<Response> {
  const mode = opts.auth ?? 'access';

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { Accept: accept, ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const token = bearer(mode);
    if (token) headers.Authorization = `Bearer ${token}`;
    return await fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      // Needed so the API can set / clear the httpOnly refresh cookie.
      credentials: 'include',
      cache: 'no-store',
    });
  };

  let res: Response;
  try {
    res = await send();
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }

  if (res.status === 401 && mode === 'access' && bearer('access')) {
    if (await refreshSession()) {
      res = await send();
    } else {
      throw new ApiError(401, 'Your session has ended. Please sign in again.');
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res));
  }
  return res;
}

export async function apiFetch<T>(path: string, opts: ApiOptions<T> = {}): Promise<T> {
  const res = await request(path, opts, 'application/json');
  if (!opts.schema) return undefined as T;
  const json: unknown = res.status === 204 ? null : await res.json();
  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(0, 'The server sent an unexpected response.');
  }
  return parsed.data;
}

/** Authenticated file download (exports). Returns the file and the server's filename. */
export async function apiDownload(path: string): Promise<{ blob: Blob; filename: string }> {
  const res = await request(path, {}, '*/*');
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download';
  return { blob: await res.blob(), filename };
}

/** Saves a blob through a temporary object URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
