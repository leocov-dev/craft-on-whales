// Thin fetch wrapper for the panel's JSON API. Session-cookie auth
// (credentials: 'include'), same-origin in prod, proxied through the Vite
// dev server in dev (see quasar.config.ts devServer.proxy) — so requests are
// always relative, never an absolute backend URL.

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface ApiEnvelope {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
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
    throw new ApiError(res.status, json?.error || res.statusText || 'Request failed');
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
