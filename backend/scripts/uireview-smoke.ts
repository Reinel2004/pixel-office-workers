// One real Gemini UI Review on a drawn SAMPLE wireframe (no real page, no business data).
// Checks that Gemini accepts the four answer formats. Prints statuses and counts only, never the key.
// Run from backend/:  npx tsx scripts/uireview-smoke.ts

import { deflateSync } from 'node:zlib';
import type { SessionUser, UiReview } from '../shared/live';
import { GeminiClient } from '../src/ai/gemini';
import { loadEnvFile } from '../src/env';
import { UiReviewService, UiReviewStore } from '../src/uireview/uireview';

loadEnvFile();
const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.log('GEMINI_API_KEY is not set; nothing to test.');
  process.exit(0);
}

/** A wide "orders table" page: header, a tiny button at the bottom, many cramped columns. */
function wireframe(w: number, h: number, tinyButton: boolean): string {
  const px = Buffer.alloc((w * 3 + 1) * h);
  const fill = (x0: number, y0: number, x1: number, y1: number, [r, g, b]: number[]) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
        const i = y * (w * 3 + 1) + 1 + x * 3;
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
      }
  };
  fill(0, 0, w, h, [245, 246, 248]);
  fill(0, 0, w, 48, [30, 41, 59]); // header bar
  for (let r = 0; r < 10; r++) {
    fill(16, 70 + r * 32, w + 300, 70 + r * 32 + 26, r % 2 ? [255, 255, 255] : [235, 238, 242]); // rows running off the right edge
    for (let c = 0; c < 9; c++) fill(24 + c * 95, 78 + r * 32, 24 + c * 95 + 70, 78 + r * 32 + 8, [148, 156, 170]); // small grey text
  }
  tinyButton ? fill(w - 70, h - 26, w - 30, h - 14, [37, 99, 235]) : fill(w - 160, 10, w - 16, 40, [37, 99, 235]);
  for (let y = 0; y < h; y++) px[y * (w * 3 + 1)] = 0;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    let c = ~0;
    for (const b of td) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(~c >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const user: SessionUser = { username: 'smoke', role: 'admin', permissions: ['ui:review'] };
const svc = new UiReviewService({
  ai: new GeminiClient({ apiKey: key, model: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest', timeoutMs: 90_000 }),
  store: new UiReviewStore(null),
});
const settle = (id: string, want: string[]) =>
  new Promise<UiReview>((res) => {
    const on = (r: UiReview) => r.id === id && want.includes(r.status) && (svc.off('review', on), res(r));
    svc.on('review', on);
  });
const show = (r: UiReview) => {
  console.log('status:', r.status, r.error ?? '');
  for (const s of [...r.steps, ...r.verifications.map((v) => v.step)]) console.log(` ${s.kind.padEnd(10)} ${s.agent.padEnd(4)} ${s.status.padEnd(8)} attempts=${s.attempts}`, s.error ?? '');
};

const { review } = svc.start(user, {
  site: 'order-management',
  page: 'Orders list (sample wireframe)',
  goal: 'Staff use this on phones. Make it easier to read and to add an order.',
  device: 'both',
  shots: [{ label: 'Orders list', mimeType: 'image/png', data: wireframe(900, 420, true) }],
  noPrivateData: true,
});
let r = await settle(review.id, ['proposed', 'failed', 'cancelled']);
show(r);
console.log('findings:', r.design?.findings.length ?? 0, '+', r.usability?.findings.length ?? 0, '· changes:', r.plan?.changes.map((c) => `${c.id}[${c.kind},${c.effort},${c.risk}] solves ${c.findings.join('/') || '-'}`).join(' '));
if (r.status === 'proposed' && r.plan?.changes.length) {
  svc.accept(user, r.id, r.plan.changes.slice(0, 2).map((c) => c.id));
  svc.verify(user, r.id, { shots: [{ label: 'After', mimeType: 'image/png', data: wireframe(900, 420, false) }], noPrivateData: true });
  r = await settle(review.id, ['verified', 'proposed']);
  show(r);
  const v = r.verifications[0];
  console.log('re-check verdict:', v?.verdict, '· checks:', v?.checks.map((c) => `${c.change}=${c.result}`).join(' '), '· regressions:', v?.regressions.length);
}
console.log('requests:', r.aiRequests, 'tokens:', r.usage?.totalTokens ?? 'not reported');
