// AI usage tracker: every real request is counted (retries too), tokens and estimated cost add
// up, limits stop requests BEFORE they are sent, totals survive a restart, nothing but counts is
// stored, and only the right accounts can see or change it. Gemini is faked; no network.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AiLimits, AiUsageReport, SessionUser } from '../../shared/live';
import { FinanceAdapter } from '../adapters/finance';
import { OrdersAdapter } from '../adapters/orders';
import { GeminiClient } from '../ai/gemini';
import { AiUsageMeter, NO_LIMITS, validateLimits } from '../ai/usage';
import { createApp } from '../app';
import { Auth, hashPassword } from '../auth';
import { loadConfig } from '../config';
import { ApiClient } from '../http/client';
import { IntegrationError } from '../http/errors';
import { JobRunner } from '../jobs/runner';

const admin: SessionUser = { username: 'owner', role: 'admin', permissions: ['ai:usage', 'ai:limits'] };
const SECRET_PROMPT = 'customer Maria Santos 0917 secret prompt text';

/** A fake Gemini that answers `status` codes in order (200 = an answer with 1000 + 200 tokens). */
function fakeGemini(statuses: number[] = []) {
  let calls = 0;
  const fetchImpl = (async () => {
    const status = statuses[calls++] ?? 200;
    if (status !== 200) return new Response(JSON.stringify({ error: { message: 'x' } }), { status });
    return new Response(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 150, thoughtsTokenCount: 50, totalTokenCount: 1200 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const limits = (over: Partial<AiLimits> = {}): AiLimits => ({ ...NO_LIMITS, ...over });
const req = { contents: [{ role: 'user' as const, parts: [{ text: SECRET_PROMPT }] }] };

function setup(over: { limits?: Partial<AiLimits>; statuses?: number[]; file?: string | null; maxRetries?: number; now?: () => Date } = {}) {
  const meter = new AiUsageMeter({ file: over.file ?? null, defaults: limits(over.limits), model: 'gemini-test', saveDelayMs: 0, now: over.now });
  const g = fakeGemini(over.statuses);
  const ai = new GeminiClient({ apiKey: 'k', model: 'gemini-test', timeoutMs: 2000, maxRetries: over.maxRetries ?? 0, fetchImpl: g.fetchImpl, sleep: async () => {}, meter });
  return { meter, ai, calls: g.calls };
}

test('counts each request, its tokens and an estimated cost by feature, agent and account', async () => {
  // US$0.10 per million input tokens, US$0.40 per million output tokens.
  const { meter, ai } = setup({ limits: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 } });
  await ai.generate(req, { tag: { feature: 'task', agent: 'joy', user: 'owner' } });
  await ai.generate(req, { tag: { feature: 'discussion', agent: 'bea', user: 'boss' } });
  const r = meter.report(admin);
  assert.equal(r.todayTotals.requests, 2);
  assert.equal(r.todayTotals.ok, 2);
  assert.equal(r.todayTotals.promptTokens, 2000);
  assert.equal(r.todayTotals.outputTokens, 400, 'output includes thinking tokens');
  assert.equal(r.todayTotals.totalTokens, 2400);
  // 1000 × 0.1/1M + 200 × 0.4/1M = 0.00018 per request
  assert.ok(Math.abs((r.todayTotals.costUsd ?? 0) - 0.00036) < 1e-9);
  assert.deepEqual(r.byFeature.map((g) => g.key).sort(), ['discussion', 'task']);
  assert.deepEqual(r.byAgent.map((g) => g.key).sort(), ['bea', 'joy']);
  assert.equal(r.byUser.find((g) => g.key === 'owner')?.totalTokens, 1200);
  assert.equal(r.recent.length, 2);
  assert.equal(r.recent[0].agent, 'bea', 'most recent first');
  assert.equal(r.days.length, 30);
  assert.equal(r.days[29].requests, 2, 'today is the last day');
  assert.equal(r.yourRequestsToday, 1);
});

test('no prices = no cost estimate and no budget enforcement', async () => {
  const { meter, ai } = setup({ limits: { monthlyBudgetUsd: 0 } });
  await ai.generate(req, { tag: { feature: 'task' } });
  await ai.generate(req, { tag: { feature: 'task' } });
  const r = meter.report(admin);
  assert.equal(r.todayTotals.costUsd, null);
  assert.equal(r.todayTotals.requests, 2, 'a budget without prices does not block');
  assert.ok(r.notes.some((n) => /not enforced until both prices/.test(n)));
});

test('a reached daily request limit stops the request BEFORE it is sent', async () => {
  const { meter, ai, calls } = setup({ limits: { dailyRequests: 2 } });
  await ai.generate(req, { tag: { feature: 'task' } });
  await ai.generate(req, { tag: { feature: 'task' } });
  await assert.rejects(ai.generate(req, { tag: { feature: 'task', agent: 'joy' } }), (e: IntegrationError) => e.code === 'AI_LIMIT' && /2 requests per day/.test(e.message));
  assert.equal(calls(), 2, 'Gemini was not called a third time');
  const r = meter.report(admin);
  assert.equal(r.todayTotals.requests, 2);
  assert.equal(r.todayTotals.blocked, 1);
  assert.equal(r.recent[0].outcome, 'blocked');
  assert.equal(r.limitStates.find((s) => s.id === 'dailyRequests')?.level, 'reached');
});

test('the per-account limit blocks only that account; 0 pauses the AI', async () => {
  const { ai, calls } = setup({ limits: { userDailyRequests: 1 } });
  await ai.generate(req, { tag: { feature: 'task', user: 'a' } });
  await assert.rejects(ai.generate(req, { tag: { feature: 'task', user: 'a' } }), { code: 'AI_LIMIT' });
  await ai.generate(req, { tag: { feature: 'task', user: 'b' } });
  assert.equal(calls(), 2);

  const paused = setup({ limits: { dailyRequests: 0 } });
  await assert.rejects(paused.ai.generate(req), { code: 'AI_LIMIT' });
  assert.equal(paused.calls(), 0);
});

test('token limit and monthly budget (with prices)', async () => {
  const t = setup({ limits: { dailyTokens: 2000 } });
  await t.ai.generate(req);
  await t.ai.generate(req); // 1200 used before it: allowed, ends at 2400
  await assert.rejects(t.ai.generate(req), { code: 'AI_LIMIT' });

  // US$1 per million input → 0.001 per request (1000 input tokens); budget 0.0015 → 2 requests.
  const b = setup({ limits: { inputUsdPerMillion: 1, outputUsdPerMillion: 0, monthlyBudgetUsd: 0.0015 } });
  await b.ai.generate(req);
  await b.ai.generate(req);
  await assert.rejects(b.ai.generate(req), (e: IntegrationError) => e.code === 'AI_LIMIT' && /budget/.test(e.message));
});

test('retries and failures are counted as real requests', async () => {
  const { meter, ai, calls } = setup({ statuses: [503, 200], maxRetries: 1 });
  await ai.generate(req, { tag: { feature: 'ui-review', agent: 'kim' } });
  assert.equal(calls(), 2);
  const r = meter.report(admin);
  assert.equal(r.todayTotals.requests, 2);
  assert.equal(r.todayTotals.failed, 1);
  assert.equal(r.todayTotals.ok, 1);
  assert.equal(r.recent[1].outcome, 'UPSTREAM_ERROR');

  const f = setup({ statuses: [429] });
  await assert.rejects(f.ai.generate(req), { code: 'RATE_LIMITED' });
  assert.equal(f.meter.report(admin).todayTotals.failed, 1);
});

test('days follow Manila time and the month total adds the days up', async () => {
  let now = new Date('2026-11-09T15:30:00Z'); // 23:30 in Manila
  const { meter, ai } = setup({ now: () => now });
  await ai.generate(req);
  now = new Date('2026-11-09T16:30:00Z'); // 00:30 on the 10th in Manila
  await ai.generate(req);
  const r = meter.report(admin);
  assert.equal(r.today, '2026-11-10');
  assert.equal(r.todayTotals.requests, 1);
  assert.equal(r.monthTotals.requests, 2);
  assert.equal(r.days.find((d) => d.date === '2026-11-09')?.requests, 1);
});

test('totals and office-set limits survive a restart; the file holds counts only', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wad-usage-')), 'usage.json');
  const a = setup({ file, limits: { dailyRequests: 500 } });
  await a.ai.generate(req, { tag: { feature: 'task', agent: 'joy', user: 'owner' } });
  a.meter.setLimits(limits({ dailyRequests: 7, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 }));
  a.meter.save();
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes('Maria') && !text.includes(SECRET_PROMPT) && !text.includes('"k"'), 'no prompt, name or key in the file');

  const b = new AiUsageMeter({ file, defaults: limits({ dailyRequests: 500 }), model: 'gemini-test', saveDelayMs: 0 });
  const r = b.report(admin);
  assert.equal(r.todayTotals.requests, 1);
  assert.equal(r.limits.dailyRequests, 7);
  assert.equal(r.customized, true);
  b.setLimits(null);
  assert.equal(b.report(admin).limits.dailyRequests, 500, 'reset goes back to the server defaults');
});

test('limits typed in the office are checked', () => {
  const ok = validateLimits({ ...NO_LIMITS, dailyRequests: 300, monthlyBudgetUsd: 5.5 });
  assert.ok('limits' in ok && ok.limits.dailyRequests === 300 && ok.limits.monthlyBudgetUsd === 5.5);
  assert.ok('error' in validateLimits({ ...NO_LIMITS, dailyRequests: 2.5 }));
  assert.ok('error' in validateLimits({ ...NO_LIMITS, dailyRequests: -1 }));
  assert.ok('error' in validateLimits({ ...NO_LIMITS, dailyTokens: '100' }));
  assert.ok('error' in validateLimits({ ...NO_LIMITS, warnPercent: 10 }));
  assert.ok('error' in validateLimits('nope'));
});

test('env defaults: 500 requests a day unless changed; bad values are reported', () => {
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).config.aiLimits.dailyRequests, 500);
  assert.equal(loadConfig({ AI_DAILY_REQUEST_LIMIT: 'off' } as NodeJS.ProcessEnv).config.aiLimits.dailyRequests, null);
  const bad = loadConfig({ AI_MONTHLY_BUDGET_USD: 'ten' } as NodeJS.ProcessEnv);
  assert.equal(bad.config.aiLimits.monthlyBudgetUsd, null);
  assert.ok(bad.problems.some((p) => p.startsWith('AI_MONTHLY_BUDGET_USD')));
});

test('HTTP: managers can see usage, only admins change limits, with cross-site protection', async () => {
  const users = `owner:admin:${await hashPassword('pw-owner-1')},boss:manager:${await hashPassword('pw-boss-1')},ops:operations:${await hashPassword('pw-ops-1')}`;
  const { config } = loadConfig({ APP_USERS: users, TASK_LOG_FILE: '', STATIC_DIR: 'does-not-exist' } as NodeJS.ProcessEnv);
  const noNet = (async () => {
    throw new Error('no network in tests');
  }) as typeof fetch;
  const finance = new FinanceAdapter(config.systems.finance, new ApiClient(config.systems.finance, { timeoutMs: 100, maxRetries: 0, fetchImpl: noNet }));
  const orders = new OrdersAdapter(config.systems.orders, new ApiClient(config.systems.orders, { timeoutMs: 100, maxRetries: 0, fetchImpl: noNet }));
  const aiUsage = new AiUsageMeter({ file: null, defaults: config.aiLimits, model: 'gemini-test' });
  const audit: Record<string, unknown>[] = [];
  const app = createApp({ config, auth: new Auth(config), runner: new JobRunner({ finance, orders, maxConcurrent: 1 }), finance, orders, aiUsage, audit: (e) => audit.push(e) });
  const server = createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, cookie: string, csrf = true) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-wad-request': '1' } : {}) }, body: JSON.stringify(body) });
  const login = async (username: string, password: string) =>
    (await post('/api/auth/login', { username, password }, '')).headers.get('set-cookie')!.split(';')[0];
  try {
    const ops = await login('ops', 'pw-ops-1');
    assert.equal((await fetch(base + '/api/ai/usage', { headers: { cookie: ops } })).status, 403);
    const boss = await login('boss', 'pw-boss-1');
    const seen = (await (await fetch(base + '/api/ai/usage', { headers: { cookie: boss } })).json()) as { usage: AiUsageReport };
    assert.equal(seen.usage.canEdit, false);
    assert.equal(seen.usage.limits.dailyRequests, 500);
    assert.equal((await post('/api/ai/usage/limits', { limits: { ...NO_LIMITS, dailyRequests: 1 } }, boss)).status, 403);
    const own = await login('owner', 'pw-owner-1');
    assert.equal((await post('/api/ai/usage/limits', { limits: { ...NO_LIMITS, dailyRequests: 1 } }, own, false)).status, 403, 'cross-site protection');
    assert.equal((await post('/api/ai/usage/limits', { limits: { ...NO_LIMITS, dailyRequests: 'x' } }, own)).status, 400);
    const changed = (await (await post('/api/ai/usage/limits', { limits: { ...NO_LIMITS, dailyRequests: 50 } }, own)).json()) as { usage: AiUsageReport };
    assert.equal(changed.usage.limits.dailyRequests, 50);
    assert.equal(changed.usage.canEdit, true);
    assert.equal(audit.at(-1)?.event, 'ai-usage.limits');
    const reset = (await (await post('/api/ai/usage/limits', { reset: true }, own)).json()) as { usage: AiUsageReport };
    assert.equal(reset.usage.limits.dailyRequests, 500);
    assert.equal(reset.usage.customized, false);
  } finally {
    app.close();
    server.closeAllConnections();
    server.close();
  }
});
