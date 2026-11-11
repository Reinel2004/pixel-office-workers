// One real Gemini request: Carlo gets 3 drawn SAMPLE "video frames" (a brown door, getting
// closer) and writes a video caption. Checks that Gemini accepts the frames and the video rules.
// Prints the status and the first lines of the answer, never the key. 1 Gemini request.
// Run from backend/:  npx tsx scripts/video-smoke.ts

import { deflateSync } from 'node:zlib';
import type { SessionUser } from '../shared/live';
import type { FinanceSource, OrderSource } from '../src/adapters/types';
import { GeminiClient } from '../src/ai/gemini';
import { runAiTask } from '../src/ai/tasks';
import { loadEnvFile } from '../src/env';

loadEnvFile();
const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.log('GEMINI_API_KEY is not set; nothing to test.');
  process.exit(0);
}

/** A PNG of a brown door with panels on a light wall; `zoom` makes it bigger (the camera moving closer). */
function frame(zoom: number): string {
  const w = 320;
  const h = 240;
  const px = Buffer.alloc((w * 3 + 1) * h);
  const fill = (x0: number, y0: number, x1: number, y1: number, [r, g, b]: number[]) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(h, Math.round(y1)); y++)
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(w, Math.round(x1)); x++) {
        const i = y * (w * 3 + 1) + 1 + x * 3;
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
      }
  };
  fill(0, 0, w, h, [232, 226, 214]);
  const dw = 90 * zoom;
  const dh = 200 * zoom;
  const x0 = w / 2 - dw / 2;
  const y0 = h - dh;
  fill(x0, y0, x0 + dw, h, [120, 66, 30]);
  for (const [a, b] of [[0.12, 0.08], [0.12, 0.55]]) fill(x0 + dw * a, y0 + dh * b, x0 + dw * (1 - a), y0 + dh * (b + 0.35), [98, 52, 22]);
  fill(x0 + dw * 0.82, y0 + dh * 0.5, x0 + dw * 0.88, y0 + dh * 0.54, [200, 170, 60]);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    let c = ~0;
    for (const byte of td) {
      c ^= byte;
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

const user: SessionUser = { username: 'smoke', role: 'admin', permissions: ['social:post'] };
const out = await runAiTask(
  {
    ai: new GeminiClient({ apiKey: key, model: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest', timeoutMs: 90_000 }),
    finance: {} as FinanceSource,
    orders: {} as OrderSource,
    maxToolRounds: 1,
    maxRangeDays: 366,
    knowledgeDir: 'knowledge',
  },
  user,
  'carlo',
  'Short caption for this door video, schedule it tomorrow 9am',
  undefined,
  undefined,
  { video: { durationSec: 18, frames: [0.6, 0.8, 1].map((z) => ({ mimeType: 'image/png', data: frame(z) })) } },
);
console.log('model:', out.model);
console.log(out.answer.split('\n').slice(0, 14).join('\n'));
console.log('has schedule line:', /\*\*Schedule:\*\*/.test(out.answer));
