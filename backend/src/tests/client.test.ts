// Tests for the allowlisted HTTP client. The fetch function is replaced with a stub; these
// tests exercise our own safety rules and error mapping, not any real WAD endpoint.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, validateBaseUrl } from '../config';
import { ApiClient, collectPages } from '../http/client';
import { IntegrationError } from '../http/errors';

const allowed = new Set(['api.test.example']);
const sys = { id: 'orders' as const, name: 'WAD Order Management', baseUrl: new URL('https://api.test.example/v1/'), problems: [] };
const noSleep = async () => undefined;

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof ApiClient>[1]> = {}) {
  return new ApiClient(sys, { timeoutMs: 200, maxRetries: 2, fetchImpl, sleep: noSleep, ...extra });
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'none';
  } catch (e) {
    return e instanceof IntegrationError ? e.code : `other:${(e as Error).message}`;
  }
}

test('base URL validation enforces https, the allowlist and no embedded credentials', () => {
  assert.equal(validateBaseUrl('https://api.test.example/v1', allowed, false).url?.href, 'https://api.test.example/v1/');
  assert.match(validateBaseUrl('http://api.test.example/', allowed, false).problem!, /https/);
  assert.match(validateBaseUrl('https://evil.example/', allowed, false).problem!, /API_ALLOWED_HOSTS/);
  assert.match(validateBaseUrl('https://u:p@api.test.example/', allowed, false).problem!, /credentials/);
  assert.match(validateBaseUrl('https://api.test.example/?k=1', allowed, false).problem!, /query/);
  assert.equal(validateBaseUrl(undefined, allowed, false).url, null);
});

test('config: unconfigured systems and malformed users are reported, not guessed', () => {
  const { config, problems } = loadConfig({ APP_USERS: 'bob:admin:plain', API_ALLOWED_HOSTS: '' } as NodeJS.ProcessEnv);
  assert.equal(config.systems.finance.baseUrl, null);
  assert.equal(config.users.length, 0);
  assert.ok(problems.some((p) => /malformed/.test(p)));
});

test('requests cannot leave the approved base URL', async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return json({});
  });
  assert.equal(await code(c.getJson('https://evil.example/x')), 'HOST_NOT_ALLOWED');
  assert.equal(await code(c.getJson('//evil.example/x')), 'HOST_NOT_ALLOWED');
  assert.equal(await code(c.getJson('../admin')), 'HOST_NOT_ALLOWED');
  assert.equal(await code(c.getJson('..%2f..%2fadmin')), 'none'); // stays encoded under /v1/
  assert.equal(c.resolve('orders', { page: 2 }).href, 'https://api.test.example/v1/orders?page=2');
  assert.equal(calls, 1);
});

test('only GET is sent and redirects are not followed', async () => {
  let seen: RequestInit | undefined;
  const c = client(async (_u, init) => {
    seen = init;
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
  });
  assert.equal(await code(c.getJson('orders')), 'HOST_NOT_ALLOWED');
  assert.equal(seen?.method, 'GET');
  assert.equal(seen?.redirect, 'manual');
});

test('HTTP errors map to distinct codes', async () => {
  assert.equal(await code(client(async () => json({}, 401)).getJson('x')), 'AUTH_FAILED');
  assert.equal(await code(client(async () => json({}, 403)).getJson('x')), 'PERMISSION_DENIED');
  assert.equal(await code(client(async () => json({}, 404)).getJson('x')), 'UPSTREAM_ERROR');
  assert.equal(await code(client(async () => new Response('<html>', { status: 200 })).getJson('x')), 'INVALID_RESPONSE');
});

test('429 and 503 are retried with backoff, then succeed', async () => {
  const waits: number[] = [];
  let n = 0;
  const c = client(
    async () => {
      n++;
      if (n === 1) return json({}, 429, { 'retry-after': '2' });
      if (n === 2) return json({}, 503);
      return json({ ok: true });
    },
    { sleep: async (ms) => void waits.push(ms) },
  );
  const r = await c.getJson<{ ok: boolean }>('x');
  assert.equal(r.data.ok, true);
  assert.equal(n, 3);
  assert.equal(waits[0], 2000);
});

test('rate limiting that persists is reported as RATE_LIMITED', async () => {
  assert.equal(await code(client(async () => json({}, 429)).getJson('x')), 'RATE_LIMITED');
});

test('timeouts and network failures are reported separately', async () => {
  const hang: typeof fetch = (_u, init) =>
    new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  assert.equal(await code(client(hang, { maxRetries: 0, timeoutMs: 30 }).getJson('x')), 'TIMEOUT');
  assert.equal(await code(client(async () => Promise.reject(new TypeError('fetch failed')), { maxRetries: 0 }).getJson('x')), 'NETWORK');
});

test('oversized responses are refused', async () => {
  const big = 'x'.repeat(2000);
  assert.equal(await code(client(async () => new Response(JSON.stringify(big)), { maxBytes: 1000 }).getJson('x')), 'RESULT_TOO_LARGE');
});

test('pagination collects every page and refuses to truncate silently', async () => {
  const pages = [[1, 2], [3], [4]];
  const all = await collectPages<number, number>(async (c) => ({ items: pages[c ?? 0], next: (c ?? 0) + 1 < pages.length ? (c ?? 0) + 1 : null }), 10, 'X', 'orders');
  assert.deepEqual(all, [1, 2, 3, 4]);
  assert.equal(await code(collectPages<number, number>(async (c) => ({ items: [1], next: (c ?? 0) + 1 }), 3, 'X', 'orders')), 'RESULT_TOO_LARGE');
});

test('log lines never include query strings or headers', async () => {
  const lines: string[] = [];
  const c = client(async () => json({}), { log: (l) => lines.push(l), authHeaders: async () => ({ Authorization: 'Bearer SECRET' }) });
  await c.getJson('orders', { query: { customer: 'Juan' } });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('Juan') && !lines[0].includes('SECRET') && !lines[0].includes('?'));
});
