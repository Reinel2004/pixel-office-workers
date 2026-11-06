// The browser and the server share the same type definitions (shared/live.ts, shared/manila.ts).
// Each folder keeps its own copy so frontend/ and backend/ can each be deployed on their own
// (Vercel and Render only need their folder). backend/shared is the original.
//
//   node scripts/shared-sync.mjs           copy backend/shared -> frontend/shared
//   node scripts/shared-sync.mjs --check   fail if the two copies differ (run by `npm test`)

import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'backend', 'shared');
const to = join(root, 'frontend', 'shared');
const check = process.argv.includes('--check');

const files = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.ts')).sort() : []);
const src = files(from);
const dst = files(to);

if (check) {
  const differ = [...new Set([...src, ...dst])].filter((f) => !src.includes(f) || !dst.includes(f) || readFileSync(join(from, f), 'utf8') !== readFileSync(join(to, f), 'utf8'));
  if (differ.length) {
    console.error(`frontend/shared differs from backend/shared: ${differ.join(', ')}\nRun "npm run sync-shared" after editing backend/shared.`);
    process.exit(1);
  }
  console.log('shared/ copies match.');
} else {
  for (const f of dst) if (!src.includes(f)) rmSync(join(to, f));
  for (const f of src) copyFileSync(join(from, f), join(to, f));
  console.log(`Copied ${src.length} file(s) from backend/shared to frontend/shared.`);
}
