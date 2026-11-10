// Systems team data: response times and failures, recorded without URLs, bodies or secrets.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HealthLog, SecurityLog } from '../monitor/monitor';

test('instrumented fetch records duration and status only, and counts failures in a row', async () => {
  let t = 1_000_000;
  const h = new HealthLog(() => t);
  const statuses = [200, 500, 401];
  let i = 0;
  const f = h.instrument('orders', (async () => {
    t += 120;
    return new Response('{}', { status: statuses[i++] });
  }) as unknown as typeof fetch);
  await f('https://orders.example/api/x?token=secret');
  await f('https://orders.example/api/x?token=secret');
  await f('https://orders.example/api/x?token=secret');
  const failing = h.instrument('gemini', (async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }) as unknown as typeof fetch);
  await assert.rejects(failing('https://gemini.example'));
  const s = h.summary('orders');
  assert.equal(s.requestsLast24h, 3);
  assert.equal(s.failuresLast24h, 2);
  assert.equal(s.failuresInARowNow, 2);
  assert.deepEqual(s.failuresByStatus, { '500': 1, '401': 1 });
  assert.equal(s.averageMs, 120);
  assert.equal(h.summary('gemini').lastFailure?.status, 'TIMEOUT');
  assert.ok(!JSON.stringify(s).includes('secret'));
  t += 2 * 86_400_000;
  assert.equal(h.summary('orders').requestsLast24h, 0, 'older than 24 hours is dropped');
});

test('security summary: per-account failures, unknown usernames, one noisy source; no addresses', () => {
  let t = 5_000_000;
  const sec = new SecurityLog(() => t);
  for (let i = 0; i < 6; i++) sec.record('login_failed', { user: null, unknownUser: true, source: '203.0.113.9' });
  sec.record('login_failed', { user: 'owner', source: '198.51.100.2' });
  sec.record('login_ok', { user: 'owner', source: '198.51.100.2' });
  sec.record('permission_denied', { user: 'ops', source: '198.51.100.3', path: '/api/facebook/posts' });
  const s = sec.summary(24);
  assert.equal(s.signIns.failed, 7);
  assert.equal(s.signIns.failedForUnknownUsernames, 6);
  assert.deepEqual(s.signIns.failedByAccount, { owner: 1 });
  assert.equal(s.signIns.distinctSourcesWithFailures, 2);
  assert.equal(s.signIns.mostFailuresFromOneSource, 6);
  assert.deepEqual(s.permissionDeniedByArea, { facebook: 1 });
  assert.ok(!JSON.stringify(s).includes('203.0.113.9'));
  t += 25 * 3_600_000;
  assert.equal(sec.summary(24).signIns.failed, 0);
  assert.equal(sec.summary(168).signIns.failed, 7);
});
