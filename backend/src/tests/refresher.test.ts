// Live updates: bounded checks, pushed only on change, nothing while nobody is watching.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveRefresher } from '../live/refresher';

function setup(read: () => Promise<unknown>, listeners = { n: 1 }) {
  let now = 0;
  let reads = 0;
  const changes: unknown[] = [];
  const r = new LiveRefresher(
    [
      {
        name: 'shop',
        read: async () => {
          reads++;
          return read();
        },
        fingerprint: (v) => ({ ...(v as Record<string, unknown>), asOf: undefined }),
      },
    ],
    { intervalMs: 120_000, maxBackoffMs: 900_000, hasListeners: () => listeners.n > 0, onChange: (_n, v) => changes.push(v), now: () => now },
  );
  return {
    r,
    changes,
    reads: () => reads,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('nothing is read while nobody has the office open', async () => {
  const t = setup(async () => ({ open: 1 }), { n: 0 });
  await t.r.tick();
  assert.equal(t.reads(), 0);
  t.r.stop();
});

test('one read per interval, and a change is pushed only when the data really changed', async () => {
  let open = 1;
  const t = setup(async () => ({ open, asOf: Math.random() }));
  await t.r.tick();
  assert.equal(t.reads(), 1);
  assert.equal(t.changes.length, 1); // first value
  await t.r.tick(); // not due yet
  assert.equal(t.reads(), 1);
  t.advance(120_000);
  await t.r.tick();
  assert.equal(t.reads(), 2);
  assert.equal(t.changes.length, 1, 'only asOf changed: nothing pushed');
  open = 2;
  t.advance(120_000);
  await t.r.tick();
  assert.equal(t.changes.length, 2);
  assert.deepEqual((t.changes[1] as { open: number }).open, 2);
  t.r.stop();
});

test('a failing source waits longer each time, up to the limit, and recovers', async () => {
  let fail = true;
  const t = setup(async () => {
    if (fail) throw new Error('down');
    return { open: 1 };
  });
  await t.r.tick(); // fails: next in 240 s
  t.advance(120_000);
  await t.r.tick();
  assert.equal(t.reads(), 1, 'backed off');
  t.advance(120_000);
  await t.r.tick(); // fails again: next in 480 s
  assert.equal(t.reads(), 2);
  t.advance(479_000);
  await t.r.tick();
  assert.equal(t.reads(), 2);
  fail = false;
  t.advance(1_000);
  await t.r.tick();
  assert.equal(t.reads(), 3);
  assert.equal(t.changes.length, 1);
  t.r.stop();
});

test('a poke re-reads soon, and checks never overlap', async () => {
  let release: () => void = () => {};
  const t = setup(() => new Promise((res) => (release = () => res({ open: 1 }))));
  const first = t.r.tick();
  const second = t.r.tick(); // already running: must not start another read
  assert.equal(t.reads(), 1);
  release();
  await Promise.all([first, second]);
  t.r.poke('shop');
  t.advance(1_500);
  const third = t.r.tick();
  release();
  await third;
  assert.equal(t.reads(), 2);
  t.r.stop();
});
