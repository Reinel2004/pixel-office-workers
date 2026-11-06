// Connected Mode server: serves the built office and the read-only API bridge.
//   development: npm run dev   (in backend/; run npm run dev in frontend/ too)
//   production:  npm run build && npm start   (in backend/)

import { createServer } from 'node:http';
import { FinanceAdapter } from './adapters/finance';
import { OrdersAdapter } from './adapters/orders';
import { GeminiClient } from './ai/gemini';
import { createApp } from './app';
import { Auth } from './auth';
import { loadConfig } from './config';
import { loadEnvFile } from './env';
import { ApiClient } from './http/client';
import { createTaskLog } from './jobs/log';
import { JobRunner } from './jobs/runner';

loadEnvFile();
const { config, problems } = loadConfig();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const clientOpts = (token: string | null | undefined) => ({
  timeoutMs: config.timeoutMs,
  maxRetries: config.maxRetries,
  log,
  authHeaders: async (): Promise<Record<string, string>> => (token ? { Authorization: `Bearer ${token}` } : {}),
});
const finance = new FinanceAdapter(config.systems.finance, new ApiClient(config.systems.finance, clientOpts(config.systems.finance.token)));
const orders = new OrdersAdapter(config.systems.orders, new ApiClient(config.systems.orders, clientOpts(config.systems.orders.token)));
const taskLog = createTaskLog(config.taskLogFile);
const ai = config.ai.apiKey
  ? {
      ai: new GeminiClient({ apiKey: config.ai.apiKey, model: config.ai.model, timeoutMs: config.ai.timeoutMs, log }),
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
const app = createApp({ config, auth, runner, finance, orders, aiStatus, log });

for (const p of problems) log(`[config] ${p}`);
for (const s of [finance.status(), orders.status()]) log(`[config] ${s.name}: ${s.state}${s.problems.length ? ` — ${s.problems.join(' ')}` : ''}`);
log(`[config] AI tasks: ${ai ? `ready (Gemini, model ${config.ai.model})` : 'off — set GEMINI_API_KEY to enable'}`);

const server = createServer(app.handler);
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
