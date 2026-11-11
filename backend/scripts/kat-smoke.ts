// One real Gemini request: Kat gets a drawn SAMPLE photo (a brown panel door) and drafts a catalog
// entry. Checks that her answer has the labelled lines the office reads into the approval form.
// Nothing is sent to the catalog or GitHub. Prints the answer's entry, never the key. 1 Gemini request.
// Run from backend/:  npx tsx scripts/kat-smoke.ts

import { deflateSync } from 'node:zlib';
import type { SessionUser } from '../shared/live';
import type { FinanceSource, OrderSource } from '../src/adapters/types';
import { GeminiClient } from '../src/ai/gemini';
import { runAiTask } from '../src/ai/tasks';
import { loadEnvFile } from '../src/env';
import { catalogDraftFrom, draftProblems } from '../../frontend/src/live/catalogDraft';

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

const user: SessionUser = { username: 'smoke', role: 'marketing', permissions: ['catalog:write'] };
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
  'kat',
  'Add this to the catalog: main door, 90 x 210cm',
  { mimeType: 'image/png', data: frame(0.9) },
);
console.log('model:', out.model, '| needs info:', out.needsInfo);
console.log(out.answer);
const d = catalogDraftFrom(out.answer);
console.log('draft read by the office:', d);
console.log('ready to add:', !!d && draftProblems(d).length === 0, d ? draftProblems(d) : '');
