// Lists the Gemini models your GEMINI_API_KEY can use for text tasks, so you can pick GEMINI_MODEL.
// Usage: npm run gemini-models     (reads .env; the key is sent only to Google, never printed)

import { loadEnvFile } from '../src/env';
import { GEMINI_HOST } from '../src/ai/gemini';

loadEnvFile();
const key = process.env.GEMINI_API_KEY?.trim();
if (!key) {
  console.error('GEMINI_API_KEY is not set in .env.');
  process.exit(1);
}

const res = await fetch(`https://${GEMINI_HOST}/v1beta/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
if (!res.ok) {
  console.error(`Gemini answered HTTP ${res.status}. ${res.status === 400 || res.status === 403 ? 'The API key looks invalid.' : ''}`);
  process.exit(1);
}
const body = (await res.json()) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
const usable = (body.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(m.name));
const current = process.env.GEMINI_MODEL?.trim() || 'gemini-flash-lite-latest';
console.log(`Models this key can use (current GEMINI_MODEL: ${current}):\n`);
for (const m of usable) {
  const id = m.name.replace(/^models\//, '');
  console.log(`${id === current ? '*' : ' '} ${id.padEnd(40)} ${m.displayName ?? ''}`);
}
if (!usable.some((m) => m.name === `models/${current}`)) console.log(`\nNote: "${current}" is not in this list. Set GEMINI_MODEL in .env to one of the names above.`);
