// The only way the server talks to the business systems.
// - Requests can only go to the system's approved base URL (same origin, under its path).
// - Read-only: GET only. Redirects are never followed.
// - Timeouts, bounded retries with backoff for 429/5xx/network errors, Retry-After honoured.
// - Response size cap and JSON validation.
// - Logs method, host, path and status only — never headers, query strings, bodies or credentials.

import type { SystemId } from '../../shared/live';
import type { SystemConfig } from '../config';
import { IntegrationError } from './errors';

export interface ClientOptions {
  timeoutMs: number;
  maxRetries: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Supplies auth headers once the authentication method is documented. */
  authHeaders?: () => Promise<Record<string, string>>;
}

export interface GetOptions {
  query?: Record<string, string | number | undefined>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ApiClient {
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  constructor(
    private system: SystemConfig,
    private opts: ClientOptions,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get id(): SystemId {
    return this.system.id;
  }

  /** Resolves a relative path against the base URL and refuses anything that escapes it. */
  resolve(path: string, query?: GetOptions['query']): URL {
    const base = this.system.baseUrl;
    if (!base) throw new IntegrationError('NOT_CONFIGURED', `${this.system.name} has no approved base URL configured.`, this.system.id);
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\'))
      throw new IntegrationError('HOST_NOT_ALLOWED', 'Absolute URLs are not allowed; use a path under the approved base URL.', this.system.id);
    const url = new URL(path.replace(/^\/+/, ''), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
      throw new IntegrationError('HOST_NOT_ALLOWED', 'The request would leave the approved base URL.', this.system.id);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    return url;
  }

  async getJson<T = unknown>(path: string, options: GetOptions = {}): Promise<{ data: T; status: number }> {
    const url = this.resolve(path, options.query);
    let attempt = 0;
    for (;;) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      let res: Response;
      try {
        const headers: Record<string, string> = { Accept: 'application/json', ...(await this.opts.authHeaders?.()) };
        res = await this.fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
      } catch (e) {
        clearTimeout(timer);
        const timedOut = (e as Error)?.name === 'AbortError';
        this.logLine(url, timedOut ? 'timeout' : 'network-error', started);
        const err = timedOut
          ? new IntegrationError('TIMEOUT', `${this.system.name} did not respond within ${Math.round(this.opts.timeoutMs / 1000)} seconds.`, this.id)
          : new IntegrationError('NETWORK', `Could not reach ${this.system.name}.`, this.id);
        if (attempt < this.opts.maxRetries) {
          await this.sleep(this.backoff(attempt++));
          continue;
        }
        throw err;
      }
      clearTimeout(timer);
      this.logLine(url, String(res.status), started);

      if (res.status >= 300 && res.status < 400)
        throw new IntegrationError('HOST_NOT_ALLOWED', `${this.system.name} answered with a redirect, which is not followed.`, this.id, res.status);
      if (res.status === 401)
        throw new IntegrationError('AUTH_FAILED', `${this.system.name} rejected the server's credentials (expired or invalid).`, this.id, 401);
      if (res.status === 403)
        throw new IntegrationError('PERMISSION_DENIED', `${this.system.name} denied access to this data for the configured account.`, this.id, 403);
      if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
        const code = res.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR';
        if (attempt < this.opts.maxRetries) {
          const ra = retryAfterMs(res.headers.get('retry-after'));
          await res.body?.cancel().catch(() => undefined);
          await this.sleep(Math.min(30000, ra ?? this.backoff(attempt)));
          attempt++;
          continue;
        }
        throw new IntegrationError(
          code,
          code === 'RATE_LIMITED' ? `${this.system.name} is rate limiting requests. Try again shortly.` : `${this.system.name} is temporarily unavailable (HTTP ${res.status}).`,
          this.id,
          res.status,
        );
      }
      if (!res.ok) throw new IntegrationError('UPSTREAM_ERROR', `${this.system.name} returned HTTP ${res.status}.`, this.id, res.status);

      const text = await readLimited(res, this.opts.maxBytes ?? 10 * 1024 * 1024, this.system.name, this.id);
      try {
        return { data: JSON.parse(text) as T, status: res.status };
      } catch {
        throw new IntegrationError('INVALID_RESPONSE', `${this.system.name} returned a response that is not valid JSON.`, this.id, res.status);
      }
    }
  }

  private backoff(attempt: number) {
    return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
  }

  private logLine(url: URL, outcome: string, started: number) {
    this.opts.log?.(`[api] GET ${url.host}${url.pathname} -> ${outcome} (${Date.now() - started}ms)`);
  }
}

function retryAfterMs(h: string | null): number | null {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

async function readLimited(res: Response, max: number, name: string, id: SystemId): Promise<string> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new IntegrationError('RESULT_TOO_LARGE', `${name} returned more data than allowed in one response.`, id);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new IntegrationError('RESULT_TOO_LARGE', `${name} returned more data than allowed in one response.`, id);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Collects every page of a paginated endpoint. The page shape is supplied by the adapter once
 * the system's pagination style is documented; this only enforces the safety cap so totals are
 * never computed from a silently truncated list.
 */
export async function collectPages<T, C>(
  fetchPage: (cursor: C | null) => Promise<{ items: T[]; next: C | null }>,
  maxPages: number,
  systemName: string,
  system: SystemId,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: C | null = null;
  for (let page = 0; ; page++) {
    if (page >= maxPages)
      throw new IntegrationError('RESULT_TOO_LARGE', `${systemName} has more than ${maxPages} pages for this range. Choose a shorter date range.`, system);
    const { items, next } = await fetchPage(cursor);
    all.push(...items);
    if (next === null || next === undefined) return all;
    cursor = next;
  }
}
