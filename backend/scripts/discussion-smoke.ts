// One real Gemini team discussion against SAMPLE order data (no business system is called).
// Checks that Gemini accepts the answer formats. Prints statuses and counts only, never the key.
// Run from backend/:  npx tsx scripts/discussion-smoke.ts

import type { Discussion, SessionUser } from '../shared/live';
import type { FinanceSource, OrderRecord, OrderSource } from '../src/adapters/types';
import { GeminiClient } from '../src/ai/gemini';
import { DiscussionService, DiscussionStore } from '../src/discuss/discussions';
import { loadEnvFile } from '../src/env';

loadEnvFile();
const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.log('GEMINI_API_KEY is not set; nothing to test.');
  process.exit(0);
}
const o = (ref: string, status: string, due: string, stage: string): OrderRecord =>
  ({ ref, orderId: ref, status, isClosed: false, dueDate: due, progressPercent: 50, stage, createdDate: '2026-10-01', carpenters: ['A'] }) as OrderRecord;
const sample = [o('ORD-S1', 'In Progress', '2026-10-25', 'assembling'), o('ORD-S2', 'In Progress', '2026-11-20', 'finishing'), o('ORD-S3', 'Pending', '2026-10-30', 'production')];
const orders: OrderSource = {
  id: 'orders',
  capabilities: { orders: true, progress: true, dueDates: true, closedStatuses: true, sharedOrderId: false, carpenters: true },
  status: () => ({ id: 'orders', name: 'sample', state: 'ready', host: 'sample', problems: [], capabilities: {} }),
  listOrders: async () => sample,
  listOpenOrders: async () => sample,
};
const finance = { id: 'finance', capabilities: {}, status: () => ({}) } as unknown as FinanceSource;
const user: SessionUser = { username: 'smoke', role: 'operations', permissions: ['orders:read'] };
const svc = new DiscussionService({
  ai: new GeminiClient({ apiKey: key, model: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest', timeoutMs: 90_000 }),
  finance,
  orders,
  store: new DiscussionStore(null),
  knowledgeDir: 'knowledge',
  maxRangeDays: 366,
});
svc.start(user, { topic: 'Bakit delayed ang mga orders namin?', participants: ['paolo', 'dev'], range: { from: '2026-10-01', to: '2026-11-07' } });
const d: Discussion = await new Promise((res) => svc.on('discussion', (x: Discussion) => ['completed', 'failed', 'cancelled'].includes(x.status) && res(x)));
console.log('status:', d.status, d.error ? `(${d.error})` : '');
for (const m of d.messages)
  console.log(
    ` ${m.round.padEnd(9)} ${m.agent.padEnd(6)} ${m.status.padEnd(8)} attempts=${m.attempts}`,
    m.error ?? '',
    m.proposal ? `findings=${m.proposal.findings.length} actions=${m.proposal.actions.length} refs=${m.proposal.findings.flatMap((f) => f.evidence).join(',')}` : '',
    m.review ? `critiques=${m.review.critiques.length}` : '',
    m.synthesis ? `actions=${m.synthesis.actions.length} summaryChars=${m.synthesis.summary.length}` : '',
  );
console.log('requests:', d.aiRequests, 'tokens:', d.usage?.totalTokens ?? 'not reported', 'evidence:', d.evidence.map((e) => e.id).join(','));
const s = d.messages.find((m) => m.round === 'synthesis')?.synthesis;
if (s) console.log('summary preview:', s.summary.slice(0, 160));
