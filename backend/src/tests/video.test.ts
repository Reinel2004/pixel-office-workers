// Videos: Carlo sees still frames (checked like photos, never the video), the video is uploaded
// to the server in pieces (offsets, size and real signature checked), posted to Facebook in
// resumable steps at most once, scheduled with Facebook's scheduler, and cleaned up.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Job, SessionUser, VideoUploadStatus } from '../../shared/live';
import { VIDEO_CHUNK_BYTES } from '../../shared/live';
import type { FinanceSource, OrderSource } from '../adapters/types';
import { GeminiClient } from '../ai/gemini';
import { createApp } from '../app';
import { Auth, hashPassword } from '../auth';
import { loadConfig } from '../config';
import { checkVideo, JobRunner, SubmitError } from '../jobs/runner';
import { FacebookClient } from '../social/facebook';
import { looksLikeVideo, VideoUploadError, VideoUploads } from '../social/videos';

const admin: SessionUser = { username: 'owner', role: 'admin', permissions: ['social:post'] };
// The smallest valid JPEG header + some bytes (enough for the signature check).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]).toString('base64');
const frames = (n: number) => Array.from({ length: n }, () => ({ mimeType: 'image/jpeg', data: JPEG }));
/** A fake MP4: an "ftyp" atom first, then filler. */
const mp4 = (size: number) => {
  const b = Buffer.alloc(size, 7);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'latin1');
  return b;
};

test('video frames are checked like photos, only for Carlo, with type, size and length limits', () => {
  const ok = checkVideo('carlo', { mimeType: 'video/mp4', bytes: 5_000_000, durationSec: 31.42, frames: frames(6) });
  assert.equal(ok.frames.length, 6);
  assert.equal(ok.meta.durationSec, 31.4);
  const bad = (v: unknown, agent: 'carlo' | 'bea' = 'carlo') => assert.throws(() => checkVideo(agent, v), (e: SubmitError) => e instanceof SubmitError);
  bad({ mimeType: 'video/mp4', bytes: 1, durationSec: 3, frames: frames(1) }, 'bea');
  bad({ mimeType: 'video/avi', bytes: 1, durationSec: 3, frames: frames(1) });
  bad({ mimeType: 'video/mp4', bytes: 500 * 1024 * 1024, durationSec: 3, frames: frames(1) });
  bad({ mimeType: 'video/mp4', bytes: 1000, durationSec: 0, frames: frames(1) });
  bad({ mimeType: 'video/mp4', bytes: 1000, durationSec: 3, frames: frames(7) });
  bad({ mimeType: 'video/mp4', bytes: 1000, durationSec: 3, frames: [{ mimeType: 'image/jpeg', data: Buffer.from('not a jpeg').toString('base64') }] });
});

test("Carlo's video task: the frames reach Gemini labelled in order, with the video rules; the video never does", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_u: URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '**Caption** A walk around our new narra door.' }] }, finishReason: 'STOP' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const noData = {} as FinanceSource;
  const runner = new JobRunner({
    finance: noData,
    orders: {} as OrderSource,
    maxConcurrent: 1,
    ai: { ai: new GeminiClient({ apiKey: 'k', model: 'm', timeoutMs: 2000, maxRetries: 0, fetchImpl }), maxToolRounds: 1, maxRangeDays: 366, knowledgeDir: join(tmpdir(), 'none') },
  });
  const { job } = runner.submitAi(admin, 'carlo', '', undefined, undefined, undefined, { mimeType: 'video/mp4', bytes: 9_000_000, durationSec: 60, frames: frames(3) });
  assert.equal(job.prompt, 'Write a Facebook caption for this video.');
  assert.deepEqual(job.video, { mimeType: 'video/mp4', bytes: 9_000_000, durationSec: 60, frames: 3, sha256: job.video!.sha256 });
  const done = await new Promise<Job>((res) => runner.on('job', (j: Job) => j.id === job.id && j.status === 'ready_for_review' && res(j)));
  assert.match(done.steps[0].result!.answer!, /narra door/);
  const parts = (bodies[0].contents as { parts: Record<string, unknown>[] }[])[0].parts;
  assert.equal(parts.filter((p) => 'inlineData' in p).length, 3);
  assert.deepEqual(parts.filter((p) => 'text' in p).slice(0, 3).map((p) => p.text), ['Video frame 1 of 3, at about 10 s:', 'Video frame 2 of 3, at about 30 s:', 'Video frame 3 of 3, at about 50 s:']);
  assert.match(JSON.stringify(bodies[0].systemInstruction), /3 still frames taken evenly from it \(it is 1 min 0 s long\)/);
  assert.throws(() => runner.submitAi(admin, 'carlo', 'x', { mimeType: 'image/jpeg', data: JPEG }, undefined, undefined, { mimeType: 'video/mp4', bytes: 1, durationSec: 1, frames: frames(1) }), /one photo, several photos or a video/);
});

/** A fake Graph API for the resumable video upload; records each call's fields. */
function fakeGraph(opts: { chunk: number; failFinish?: boolean } = { chunk: 4 }) {
  const calls: { path: string; fields: Record<string, string>; chunkBytes?: number }[] = [];
  let size = 0;
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    const fields: Record<string, string> = {};
    let chunkBytes: number | undefined;
    if (init?.body instanceof FormData)
      for (const [k, v] of (init.body as unknown as { entries(): Iterable<[string, unknown]> }).entries()) {
        if (typeof v === 'string') fields[k] = v;
        else chunkBytes = (v as Blob).size;
      }
    calls.push({ path: url.pathname, fields, chunkBytes });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (fields.upload_phase === 'start') size = Number(fields.file_size);
    if (fields.upload_phase === 'start') return ok({ upload_session_id: 'sess1', video_id: '123456789', start_offset: '0', end_offset: String(Math.min(opts.chunk, Number(fields.file_size))) });
    if (fields.upload_phase === 'transfer') {
      const next = Number(fields.start_offset) + (chunkBytes ?? 0);
      return ok({ start_offset: String(next), end_offset: String(Math.min(size, next + opts.chunk)) });
    }
    if (fields.upload_phase === 'finish') return opts.failFinish ? new Response(JSON.stringify({ error: { code: 100, message: 'bad video' } }), { status: 400 }) : ok({ success: true });
    if (url.pathname.endsWith('/123456789') && init?.method === 'GET') return ok({ permalink_url: '/wad/videos/123456789/', from: { id: 'PAGE1' } });
    return ok({});
  }) as unknown as typeof fetch;
  return { fb: new FacebookClient({ pageId: 'PAGE1', token: 'tok', version: 'v27.0', timeoutMs: 2000, fetchImpl }), calls, fetchImpl };
}

test('Facebook: start -> transfer the parts Facebook asks for -> finish with the schedule', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wad-vid-'));
  const v = new VideoUploads({ dir });
  const up = v.create('owner', 16, 'video/mp4');
  const data = mp4(24).subarray(0, 16);
  await v.append('owner', up.id, 0, data);
  const { fb, calls } = fakeGraph({ chunk: 4 });
  const at = Math.floor(Date.now() / 1000) + 3600;
  let done: unknown = null;
  v.post('owner', up.id, { message: 'New door!', at }, fb, { done: (r) => (done = r) });
  assert.equal(v.post('owner', up.id, { message: 'New door!', at }, fb).state, 'posting', 'a second click does not post again');
  while (!done) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls.filter((c) => c.fields.upload_phase).map((c) => [c.fields.upload_phase, c.fields.start_offset ?? '', c.chunkBytes ?? 0]), [
    ['start', '', 0],
    ['transfer', '0', 4],
    ['transfer', '4', 4],
    ['transfer', '8', 4],
    ['transfer', '12', 4],
    ['finish', '', 0],
  ]);
  const finish = calls.find((c) => c.fields.upload_phase === 'finish')!.fields;
  assert.equal(finish.description, 'New door!');
  assert.equal(finish.published, 'false');
  assert.equal(finish.scheduled_publish_time, String(at));
  const s = v.status('owner', up.id);
  assert.equal(s.state, 'posted');
  assert.equal(s.post?.link, 'https://www.facebook.com/wad/videos/123456789/');
  assert.equal(existsSync(join(dir, `${up.id}.mp4`)), false, 'the temporary file is deleted');
  v.close();
});

test('uploads: owner only, in order, within the declared size, and a real video signature', async () => {
  const v = new VideoUploads({ dir: mkdtempSync(join(tmpdir(), 'wad-vid-')) });
  assert.throws(() => v.create('owner', 1000, 'video/x-msvideo'), VideoUploadError);
  assert.throws(() => v.create('owner', 999 * 1024 * 1024, 'video/mp4'), (e: VideoUploadError) => e.status === 413);
  const up = v.create('owner', 30, 'video/quicktime');
  await assert.rejects(v.append('other', up.id, 0, mp4(30)), (e: VideoUploadError) => e.status === 404);
  await assert.rejects(v.append('owner', up.id, 5, mp4(10)), (e: VideoUploadError) => e.status === 409);
  await assert.rejects(v.append('owner', up.id, 0, mp4(31)), (e: VideoUploadError) => e.status === 400);
  const fake = v.create('owner', 30, 'video/mp4');
  await assert.rejects(v.append('owner', fake.id, 0, Buffer.alloc(30, 65)), /not a valid MP4/);
  assert.throws(() => v.status('owner', fake.id), VideoUploadError, 'a fake file is dropped');
  assert.ok(looksLikeVideo(mp4(16)));
  assert.equal((await v.append('owner', up.id, 0, mp4(30))).state, 'received');
  assert.throws(() => v.post('owner', v.create('owner', 30, 'video/mp4').id, { message: 'x' }, fakeGraph().fb), /not finished uploading/);
  v.close();
});

test('a failed Facebook post keeps the video for "try again"; scheduled videos can be cancelled only if they are this Page\'s', async () => {
  const v = new VideoUploads({ dir: mkdtempSync(join(tmpdir(), 'wad-vid-')) });
  const up = v.create('owner', 16, 'video/mp4');
  await v.append('owner', up.id, 0, mp4(24).subarray(0, 16));
  const { fb } = fakeGraph({ chunk: 16, failFinish: true });
  let failed = false;
  v.post('owner', up.id, { message: 'x' }, fb, { failed: () => (failed = true) });
  while (!failed) await new Promise((r) => setTimeout(r, 5));
  const s = v.status('owner', up.id);
  assert.equal(s.state, 'received');
  assert.match(s.error!, /bad video.*try again/i);
  v.close();

  const { fb: g, calls } = fakeGraph();
  await g.cancel('123456789');
  assert.ok(calls.some((c) => c.path.endsWith('/123456789')));
  const other = new FacebookClient({ pageId: 'OTHERPAGE', token: 't', version: 'v27.0', timeoutMs: 1000, fetchImpl: fakeGraph().fetchImpl });
  await assert.rejects(other.cancel('123456789'), /not a video on this Page/);
});

test('HTTP: a video goes up in pieces and posts once; cross-site and other accounts are refused', async () => {
  const users = `owner:admin:${await hashPassword('pw-owner-1')},ops:operations:${await hashPassword('pw-ops-1')}`;
  const { config } = loadConfig({ APP_USERS: users, TASK_LOG_FILE: '', STATIC_DIR: 'does-not-exist' } as NodeJS.ProcessEnv);
  const { fb } = fakeGraph({ chunk: VIDEO_CHUNK_BYTES });
  const videos = new VideoUploads({ dir: mkdtempSync(join(tmpdir(), 'wad-vid-')) });
  const runner = new JobRunner({ finance: {} as FinanceSource, orders: {} as OrderSource, maxConcurrent: 1 });
  const stub = { status: () => ({ id: 'orders', name: 'x', state: 'not_configured', host: null, problems: [], capabilities: {} }) };
  const app = createApp({ config, auth: new Auth(config), runner, finance: stub as never, orders: stub as never, facebook: fb, videos });
  const server = createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const req = (method: string, path: string, body: BodyInit | null, cookie: string, csrf = true, type = 'application/json') =>
    fetch(base + path, { method, headers: { 'content-type': type, cookie, ...(csrf ? { 'x-wad-request': '1' } : {}) }, body });
  const login = async (u: string, p: string) => (await req('POST', '/api/auth/login', JSON.stringify({ username: u, password: p }), '')).headers.get('set-cookie')!.split(';')[0];
  try {
    const own = await login('owner', 'pw-owner-1');
    const ops = await login('ops', 'pw-ops-1');
    const size = 16;
    assert.equal((await req('POST', '/api/facebook/videos', JSON.stringify({ bytes: size, mimeType: 'video/mp4' }), ops)).status, 403);
    assert.equal((await req('POST', '/api/facebook/videos', JSON.stringify({ bytes: size, mimeType: 'video/mp4' }), own, false)).status, 403);
    const { upload } = (await (await req('POST', '/api/facebook/videos', JSON.stringify({ bytes: size, mimeType: 'video/mp4' }), own)).json()) as { upload: VideoUploadStatus };
    const bytes = mp4(24).subarray(0, size);
    const put = await req('PUT', `/api/facebook/videos/${upload.id}?offset=0`, bytes, own, true, 'application/octet-stream');
    assert.equal(((await put.json()) as { upload: VideoUploadStatus }).upload.state, 'received');
    assert.equal((await req('POST', `/api/facebook/videos/${upload.id}/post`, JSON.stringify({ message: '' }), own)).status, 400);
    const posted = await req('POST', `/api/facebook/videos/${upload.id}/post`, JSON.stringify({ message: 'Our new door' }), own);
    assert.equal(posted.status, 202);
    let s: VideoUploadStatus;
    do {
      await new Promise((r) => setTimeout(r, 10));
      s = ((await (await req('GET', `/api/facebook/videos/${upload.id}`, null, own)).json()) as { upload: VideoUploadStatus }).upload;
    } while (s.state === 'posting');
    assert.equal(s.state, 'posted');
    assert.equal(s.post?.postId, '123456789');
  } finally {
    app.close();
    videos.close();
    server.closeAllConnections();
    server.close();
  }
});
