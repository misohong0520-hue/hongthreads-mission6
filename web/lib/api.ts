import type { SessionInfo } from './resources';

export class ApiError extends Error {
  status: number;
  code: string;
  fields: Record<string, string>;
  constructor(status: number, value: unknown) {
    const data = value && typeof value === 'object' ? value as { error?: { code?: string; message?: string; fields?: Record<string, string> } | string; message?: string; fields?: Record<string, string> } : {};
    const error = typeof data.error === 'object' ? data.error : {};
    super(error.message || data.message || (status === 404 ? '요청한 자료를 찾을 수 없습니다.' : status === 409 ? '다른 화면에서 자료가 수정됐습니다. 최신 자료를 확인해 주세요.' : status === 503 ? '저장소에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.' : '요청을 처리하지 못했습니다. 다시 시도해 주세요.'));
    this.status = status;
    this.code = error.code || String(status);
    this.fields = error.fields || data.fields || {};
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/workspace/api/${path.replace(/^\//, '')}`, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch { throw new Error('네트워크에 연결할 수 없습니다. 연결 상태를 확인해 주세요.'); }
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data);
  return data as T;
}

export const getSession = () => request<SessionInfo>('session');
export async function mutate<T>(path: string, method: string, body?: unknown): Promise<T> {
  const session = await getSession();
  return request<T>(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export async function upload(file: File) {
  const session = await getSession();
  const form = new FormData(); form.set('file', file);
  return request<{ data: import('./resources').Asset }>('v1/uploads', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken }, body: form });
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : '요청을 처리하지 못했습니다.'; }
export function formatDate(value?: string) { if (!value) return '방금'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeZone: 'Asia/Seoul' }).format(date); }
