// Thin fetch wrapper for the panel's JSON API. Session-cookie auth
// (credentials: 'include'), same-origin in prod, proxied through the Vite
// dev server in dev (see quasar.config.ts devServer.proxy) — so requests are
// always relative, never an absolute backend URL.

export class ApiError extends Error {
  status: number;
  /** The parsed JSON error body, for errors that carry structured data (e.g. `blocked`). */
  body: Record<string, unknown> | null;

  constructor(status: number, message: string, body: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

interface ApiEnvelope {
  ok?: boolean;
  error?: string;
  message?: unknown;
  [key: string]: unknown;
}

/**
 * The human-readable reason. Nest's HttpException bodies are
 * `{ statusCode, message, error }`, where `error` is only the status name
 * ("Conflict") and `message` is the reason (an array for validation errors).
 * Handlers that answer `{ ok: false, error }` themselves put it in `error`.
 */
function errorMessage(json: ApiEnvelope | null): string | null {
  if (typeof json?.message === 'string' && json.message) return json.message;
  if (Array.isArray(json?.message) && json.message.length) return json.message.join('; ');
  return json?.error || null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // FormData goes as-is so fetch sets the multipart boundary itself.
  const form = body instanceof FormData;
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
    },
    body: form ? body : body !== undefined ? JSON.stringify(body) : null,
  });

  const text = await res.text();
  let json: ApiEnvelope | null = null;
  try {
    json = text ? (JSON.parse(text) as ApiEnvelope) : null;
  } catch {
    // non-JSON response — fall through, res.ok/status still drive the error path
  }

  if (!res.ok || json?.ok === false) {
    throw new ApiError(res.status, errorMessage(json) || res.statusText || 'Request failed', json);
  }

  return (json ?? ({} as T)) as T;
}

export const http = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  delete: <T>(path: string) => request<T>('DELETE', path),
  /** Multipart POST (file uploads). */
  postForm: <T>(path: string, form: FormData) => request<T>('POST', path, form),
};
