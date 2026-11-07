// Facebook Page posting: request shapes, scheduling, errors, permissions, no double posts.
// Facebook is faked; nothing is posted anywhere.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { FinanceAdapter } from '../adapters/finance';
import { OrdersAdapter } from '../adapters/orders';
import { createApp } from '../app';
import { Auth, hashPassword } from '../auth';
import { loadConfig } from '../config';
import { ApiClient } from '../http/client';
import { JobRunner } from '../jobs/runner';
import { FacebookClient, FacebookError } from '../social/facebook';

const PAGE = '1234567890';
const TOKEN = 'fb-page-token-must-stay-secret';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 9)]).toString('base64');

interface Call {
  method: string;
  url: URL;
  auth: string | null;
  form: Record<string, string>;
  file?: { type: string; size: number };
}

/** A fake Graph API that records each call and answers from a list (or a default). */
function fakeGraph(replies: ((c: Call) => { status?: number; body: unknown })[] = []) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: URL, init?: RequestInit) => {
    const form: Record<string, string> = {};
    let file: Call['file'];
    if (init?.body instanceof FormData) {
      init.body.forEach((v, k) => {
        if (typeof v === 'string') form[k] = v;
        else file = { type: v.type, size: v.size };
      });
    }
    const c: Call = { method: init?.method ?? 'GET', url: new URL(String(input)), auth: new Headers(init?.headers).get('authorization'), form, file };
    calls.push(c);
    const r = replies[i++]?.(c) ?? { body: { id: `${PAGE}_999`, permalink_url: 'https://www.facebook.com/wad/posts/999' } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const client = new FacebookClient({ pageId: PAGE, token: TOKEN, version: 'v27.0', timeoutMs: 2000, fetchImpl, appSecret: 'shh' });
  return { client, calls };
}

test('post now with a photo: one /photos call with the caption, token in the header only', async () => {
  const g = fakeGraph([() => ({ body: { id: '555', post_id: `${PAGE}_777` } }), () => ({ body: { permalink_url: 'https://www.facebook.com/p/777' } })]);
  const r = await g.client.publish({ message: 'Crafted with care. #WADFurniture', image: { mimeType: 'image/jpeg', data: JPEG } });
  assert.deepEqual(r, { postId: `${PAGE}_777`, link: 'https://www.facebook.com/p/777', scheduledAt: null });
  const [up, link] = g.calls;
  assert.equal(up.method, 'POST');
  assert.equal(up.url.pathname, `/v27.0/${PAGE}/photos`);
  assert.equal(up.form.caption, 'Crafted with care. #WADFurniture');
  assert.equal(up.form.published, 'true');
  assert.deepEqual(up.file, { type: 'image/jpeg', size: 104 });
  assert.equal(link.url.pathname, `/v27.0/${PAGE}_777`);
  for (const c of g.calls) {
    assert.equal(c.auth, `Bearer ${TOKEN}`);
    assert.ok(!c.url.toString().includes(TOKEN), 'token never in a URL');
    assert.match(c.url.searchParams.get('appsecret_proof') ?? '', /^[0-9a-f]{64}$/);
  }
});

test('scheduled photo post: unpublished temporary upload, then a scheduled feed post that attaches it', async () => {
  const g = fakeGraph([() => ({ body: { id: '4242' } }), () => ({ body: { id: `${PAGE}_888` } }), () => ({ body: {} })]);
  const at = Math.floor(Date.parse('2026-11-10T09:00:00+08:00') / 1000);
  const r = await g.client.publish({ message: 'Coming soon', image: { mimeType: 'image/jpeg', data: JPEG }, at });
  assert.equal(r.postId, `${PAGE}_888`);
  assert.equal(r.scheduledAt, '2026-11-10T01:00:00.000Z');
  const [up, feed] = g.calls;
  assert.equal(up.url.pathname, `/v27.0/${PAGE}/photos`);
  assert.equal(up.form.published, 'false');
  assert.equal(up.form.temporary, 'true');
  assert.equal(up.form.caption, undefined);
  assert.equal(feed.url.pathname, `/v27.0/${PAGE}/feed`);
  assert.equal(feed.form.message, 'Coming soon');
  assert.equal(feed.form['attached_media[0]'], JSON.stringify({ media_fbid: '4242' }));
  assert.equal(feed.form.published, 'false');
  assert.equal(feed.form.scheduled_publish_time, String(at));
  assert.equal(feed.form.unpublished_content_type, 'SCHEDULED');
});

test('text-only post now goes to /feed; scheduled posts are listed soonest first', async () => {
  const g = fakeGraph([
    () => ({ body: { id: `${PAGE}_1` } }),
    () => ({ body: {} }),
    () => ({
      body: {
        data: [
          { id: `${PAGE}_3`, message: 'Later', scheduled_publish_time: 1_800_000_000, full_picture: 'https://scontent.example/x.jpg', permalink_url: 'https://www.facebook.com/3' },
          { id: `${PAGE}_2`, message: 'Sooner', scheduled_publish_time: 1_790_000_000 },
        ],
      },
    }),
  ]);
  await g.client.publish({ message: 'Hello' });
  assert.equal(g.calls[0].url.pathname, `/v27.0/${PAGE}/feed`);
  assert.equal(g.calls[0].form.published, undefined);
  const list = await g.client.scheduled();
  assert.deepEqual(
    list.map((p) => [p.message, p.hasPicture]),
    [
      ['Sooner', false],
      ['Later', true],
    ],
  );
  assert.equal(g.calls[2].url.pathname, `/v27.0/${PAGE}/scheduled_posts`);
});

test('Graph errors become clear messages; only this Page\'s posts can be cancelled', async () => {
  const expired = fakeGraph([() => ({ status: 400, body: { error: { code: 190, message: 'Error validating access token' } } })]);
  await assert.rejects(expired.client.publish({ message: 'x' }), (e: FacebookError) => e.code === 'AUTH_FAILED' && !e.message.includes(TOKEN));
  const perm = fakeGraph([() => ({ status: 403, body: { error: { code: 200, message: 'Requires pages_manage_posts' } } })]);
  await assert.rejects(perm.client.publish({ message: 'x' }), (e: FacebookError) => e.code === 'PERMISSION_DENIED');
  const g = fakeGraph();
  await assert.rejects(g.client.cancel('999_111'), (e: FacebookError) => e.code === 'INVALID');
  assert.equal(g.calls.length, 0);
  await g.client.cancel(`${PAGE}_111`);
  assert.equal(g.calls[0].method, 'DELETE');
  assert.equal(g.calls[0].url.pathname, `/v27.0/${PAGE}_111`);
});

// ---------------------------------------------------------------- HTTP routes

let server: Server;
let base = '';
let closeApp: () => void;
const graph = fakeGraph(Array.from({ length: 20 }, () => () => ({ body: { id: `${PAGE}_42`, permalink_url: 'https://www.facebook.com/42', name: 'WAD Furniture' } })));
const audit: Record<string, unknown>[] = [];

before(async () => {
  const users = `owner:admin:${await hashPassword('pw-owner-1')},ops:operations:${await hashPassword('pw-ops-1')},mk:marketing:${await hashPassword('pw-mk-1')}`;
  const { config } = loadConfig({ APP_USERS: users, TASK_LOG_FILE: '', FACEBOOK_PAGE_ID: PAGE, FACEBOOK_PAGE_TOKEN: TOKEN } as NodeJS.ProcessEnv);
  const fetchImpl = (async () => {
    throw new Error('no network');
  }) as typeof fetch;
  const finance = new FinanceAdapter(config.systems.finance, new ApiClient(config.systems.finance, { timeoutMs: 100, maxRetries: 0, fetchImpl }));
  const orders = new OrdersAdapter(config.systems.orders, new ApiClient(config.systems.orders, { timeoutMs: 100, maxRetries: 0, fetchImpl }));
  const app = createApp({ config, auth: new Auth(config), runner: new JobRunner({ finance, orders, maxConcurrent: 1 }), finance, orders, facebook: graph.client, audit: (e) => audit.push(e) });
  closeApp = app.close;
  server = createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  closeApp();
  server.closeAllConnections();
  server.close();
});

const req = (method: string, path: string, body?: unknown, cookie = '') =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-wad-request': '1', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
async function login(u: string, p: string) {
  const r = await req('POST', '/api/auth/login', { username: u, password: p });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie')!.split(';')[0];
}

test('only accounts with social:post can post; marketing can, operations cannot', async () => {
  const ops = await login('ops', 'pw-ops-1');
  assert.equal((await req('GET', '/api/facebook/status', undefined, ops)).status, 403);
  assert.equal((await req('POST', '/api/facebook/posts', { key: 'k-ops-000001', message: 'x' }, ops)).status, 403);
  const mk = await login('mk', 'pw-mk-1');
  const st = await (await req('GET', '/api/facebook/status', undefined, mk)).json();
  assert.equal(st.facebook.configured, true);
  assert.ok(!JSON.stringify(st).includes(TOKEN));
});

test('one approval posts once: the same key never posts twice', async () => {
  const owner = await login('owner', 'pw-owner-1');
  const before = graph.calls.filter((c) => c.method === 'POST').length;
  const body = { key: 'approval-0001', message: 'Crafted with care.', image: { mimeType: 'image/jpeg', data: JPEG } };
  const a = await (await req('POST', '/api/facebook/posts', body, owner)).json();
  const b = await (await req('POST', '/api/facebook/posts', body, owner)).json();
  assert.equal(a.post.postId, `${PAGE}_42`);
  assert.equal(b.repeated, true);
  assert.equal(graph.calls.filter((c) => c.method === 'POST').length - before, 1);
  const entry = audit.find((e) => e.event === 'facebook.posted')!;
  assert.equal(entry.user, 'owner');
  assert.equal(entry.messageChars, 18);
  assert.ok(!JSON.stringify(audit).includes(JPEG.slice(0, 30)) && !JSON.stringify(audit).includes(TOKEN));
});

test('schedule window and input checks', async () => {
  const owner = await login('owner', 'pw-owner-1');
  const post = (extra: Record<string, unknown>, key: string) => req('POST', '/api/facebook/posts', { key, message: 'Soon', ...extra }, owner);
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  const far = new Date(Date.now() + 40 * 86_400_000).toISOString();
  const ok = new Date(Date.now() + 2 * 86_400_000).toISOString();
  assert.equal((await post({ scheduleAt: soon }, 'win-00000001')).status, 400);
  assert.equal((await post({ scheduleAt: far }, 'win-00000002')).status, 400);
  assert.equal((await post({ scheduleAt: 'next tuesday' }, 'win-00000003')).status, 400);
  assert.equal((await post({ message: '' }, 'win-00000004')).status, 400);
  assert.equal((await post({ image: { mimeType: 'image/png', data: JPEG } }, 'win-00000005')).status, 400);
  assert.equal((await req('POST', '/api/facebook/posts', { message: 'no key' }, owner)).status, 400);
  const r = await (await post({ scheduleAt: ok }, 'win-00000006')).json();
  assert.ok(r.post.scheduledAt);
  const last = graph.calls.filter((c) => c.method === 'POST').at(-1)!;
  assert.equal(last.form.unpublished_content_type, 'SCHEDULED');
});

test('pending posts can be listed and cancelled, with cross-site protection', async () => {
  const owner = await login('owner', 'pw-owner-1');
  assert.equal((await req('GET', '/api/facebook/scheduled', undefined, owner)).status, 200);
  const noCsrf = await fetch(`${base}/api/facebook/scheduled/${PAGE}_42`, { method: 'DELETE', headers: { cookie: owner } });
  assert.equal(noCsrf.status, 403);
  assert.equal((await req('DELETE', `/api/facebook/scheduled/${PAGE}_42`, undefined, owner)).status, 200);
  assert.ok(audit.some((e) => e.event === 'facebook.cancelled'));
});
