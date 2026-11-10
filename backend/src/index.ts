// Connected Mode server: serves the built office and the read-only API bridge.
//   development: npm run dev   (in backend/; run npm run dev in frontend/ too)
//   production:  npm run build && npm start   (in backend/)

import { createServer } from 'node:http';
import { FinanceAdapter } from './adapters/finance';
import { OrdersAdapter } from './adapters/orders';
import { GeminiClient } from './ai/gemini';
import { AiUsageMeter } from './ai/usage';
import { createApp } from './app';
import { Auth } from './auth';
import { loadConfig } from './config';
import { FacebookClient } from './social/facebook';
import { loadEnvFile } from './env';
import { ApiClient } from './http/client';
import { createTaskLog } from './jobs/log';
import { JobRunner } from './jobs/runner';
import { HealthLog } from './monitor/monitor';
import { DiscussionService, DiscussionStore } from './discuss/discussions';
import { UiReviewService, UiReviewStore } from './uireview/uireview';

loadEnvFile();
const { config, problems } = loadConfig();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

// Every outgoing call is timed for the Systems Monitor (duration and status only).
const health = new HealthLog();
const clientOpts = (token: string | null | undefined, system: 'finance' | 'orders') => ({
  timeoutMs: config.timeoutMs,
  maxRetries: config.maxRetries,
  log,
  fetchImpl: health.instrument(system),
  authHeaders: async (): Promise<Record<string, string>> => (token ? { Authorization: `Bearer ${token}` } : {}),
});
const finance = new FinanceAdapter(config.systems.finance, new ApiClient(config.systems.finance, clientOpts(config.systems.finance.token, 'finance')));
const orders = new OrdersAdapter(config.systems.orders, new ApiClient(config.systems.orders, clientOpts(config.systems.orders.token, 'orders')));
const taskLog = createTaskLog(config.taskLogFile);
// AI usage tracker: every Gemini request is checked against the limits and counted here.
const aiUsage = new AiUsageMeter({ file: config.aiUsageFile, defaults: config.aiLimits, model: config.ai.apiKey ? config.ai.model : null, log });
const ai = config.ai.apiKey
  ? {
      ai: new GeminiClient({ apiKey: config.ai.apiKey, model: config.ai.model, timeoutMs: config.ai.timeoutMs, log, fetchImpl: health.instrument('gemini'), meter: aiUsage }),
      // Sam and Ivy read these; bound to the app below (it owns sessions, streams and the logs).
      monitor: {
        health: () => app.monitor.health(),
        security: (hours: number) => app.monitor.security(hours),
      },
      maxToolRounds: config.ai.maxToolRounds,
      maxRangeDays: config.maxRangeDays,
      knowledgeDir: config.ai.knowledgeDir,
    }
  : null;
const aiStatus = () => ({
  ready: !!ai,
  provider: 'gemini',
  model: ai ? config.ai.model : null,
  problems: ai ? [] : ['GEMINI_API_KEY is not set.'],
});
const runner = new JobRunner({ finance, orders, maxConcurrent: config.maxConcurrentJobs, log: taskLog, ai });
const auth = new Auth(config);
const fb = config.facebook;
const facebook =
  fb.pageId && fb.token ? new FacebookClient({ pageId: fb.pageId, token: fb.token, appSecret: fb.appSecret, version: fb.version, timeoutMs: 60_000, log, fetchImpl: health.instrument('facebook') }) : null;
// Team discussions reuse the same Gemini client, read-only adapters and business notes.
const discussions = new DiscussionService({
  ai: ai?.ai ?? null,
  finance,
  orders,
  store: new DiscussionStore(config.discussionsFile),
  knowledgeDir: config.ai.knowledgeDir,
  maxRangeDays: config.maxRangeDays,
  log,
});
// UI Review (Aya, Kim, Rey): screenshots only, never opens a website; same Gemini client.
const uiReviews = new UiReviewService({ ai: ai?.ai ?? null, store: new UiReviewStore(config.uiReviewsFile), log });
const app = createApp({ config, auth, runner, finance, orders, aiStatus, facebook, audit: taskLog, log, health, discussions, uiReviews, aiUsage });

for (const p of problems) log(`[config] ${p}`);
log(`[config] Facebook posting: ${facebook ? `ready (Page ${fb.pageId}, Graph ${fb.version})` : `off — ${fb.problems.join(' ')}`}`);
for (const s of [finance.status(), orders.status()]) log(`[config] ${s.name}: ${s.state}${s.problems.length ? ` — ${s.problems.join(' ')}` : ''}`);
log(`[config] AI tasks: ${ai ? `ready (Gemini, model ${config.ai.model})` : 'off — set GEMINI_API_KEY to enable'}`);

const server = createServer(app.handler);
// Save the AI usage totals when the server is stopped (Render sends SIGTERM before a restart).
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.once(sig, () => {
    aiUsage.save();
    process.exit(0);
  });
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `
Port ${config.port} is already in use, most likely because the WAD AI Office server is already running ` +
        `(check your other terminals, e.g. "npm run dev"). Stop that one with Ctrl+C first, or set a different PORT in backend/.env.
`,
    );
  } else if (e.code === 'EACCES') {
    console.error(`
Not allowed to use port ${config.port}. Set a different PORT in backend/.env.
`);
  } else {
    console.error(`
The server could not start: ${e.message}
`);
  }
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  log(`WAD AI Office server on http://${config.host}:${config.port} (${config.production ? 'production' : 'development'})`);
});
