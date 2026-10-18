export class ApiError extends Error {
  status: number;
  details?: { field: string; message: string }[];
  constructor(message: string, status: number, details?: { field: string; message: string }[]) {
    super(message); this.name = 'ApiError'; this.status = status; this.details = details;
  }
}

let csrfToken = '';
async function getCsrfToken() {
  const response = await fetch('/api/auth/csrf', { credentials: 'include' });
  const payload = await response.json();
  csrfToken = payload.token;
  return csrfToken;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('x-csrf-token', await getCsrfToken());
  const response = await fetch(`/api${path}`, { ...options, method, headers, credentials: 'include' });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error ?? 'The request could not be completed.', response.status, payload.details);
  return payload as T;
}

export const jsonBody = (value: unknown) => JSON.stringify(value);
