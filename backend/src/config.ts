// Server configuration from environment variables. Each business system has a base URL and a
// Bearer token (FINANCE_API_TOKEN / ORDERS_API_TOKEN). Tokens stay on the server: they are only
// ever placed in the Authorization header of requests to that system's approved base URL.

import type { AiLimits, Permission, SystemId } from '../shared/live';
import { MAX_RANGE_DAYS, SYSTEM_NAMES } from '../shared/live';

export interface AppUser {
  username: string;
  role: string;
  passwordHash: string;
}

export interface SystemConfig {
  id: SystemId;
  name: string;
  /** Approved base URL, or null when missing/invalid. */
  baseUrl: URL | null;
  /** Bearer token for this system's API, or null when not set. Never logged or sent to the browser. */
  token?: string | null;
  problems: string[];
}

export interface FacebookConfig {
  pageId: string | null;
  token: string | null;
  appSecret: string | null;
  version: string;
  problems: string[];
}

/** The online catalog (Kat): a GitHub repository whose site rebuilds on every change. */
export interface CatalogConfig {
  /** owner/name, or null when not set up. */
  repo: string | null;
  branch: string;
  /** Folder of the catalog site inside the repository ('' = the top level). */
  folder: string;
  /** Never logged or sent to the browser. Null = adding to the catalog is off. */
  token: string | null;
  /** The live catalog, linked after a product is added. */
  siteUrl: string | null;
  problems: string[];
}

export interface AppConfig {
  facebook: FacebookConfig;
  catalog: CatalogConfig;
  port: number;
  host: string;
  production: boolean;
  cookieSecure: boolean;
  sessionTtlMs: number;
  appOrigin: string | null;
  users: AppUser[];
  allowedHosts: Set<string>;
  allowInsecureLocal: boolean;
  timeoutMs: number;
  maxRetries: number;
  maxPages: number;
  maxConcurrentJobs: number;
  /** Live updates: how often the server re-checks orders and Facebook while an office is open (ms); 0 = off. */
  liveRefreshMs: number;
  maxRangeDays: number;
  taskLogFile: string | null;
  /** Team discussions are saved here (JSON); null = kept in memory only. */
  discussionsFile: string | null;
  /** UI Reviews are saved here (JSON, without the screenshots); null = kept in memory only. */
  uiReviewsFile: string | null;
  /** The Task Board (reports and assigned tasks) is saved here (JSON); null = memory only. */
  tasksFile: string | null;
  /** AI usage totals and office-set limits are saved here (JSON); null = memory only. */
  aiUsageFile: string | null;
  /** Default AI usage limits and prices (an admin can change them in the office). */
  aiLimits: AiLimits;
  /** Folder of the built front end to serve, or null for an API-only server (front end hosted elsewhere, e.g. Vercel). */
  staticDir: string | null;
  /** Behind a reverse proxy (Render, Vercel rewrites): take the client address from X-Forwarded-For. */
  trustProxy: boolean;
  systems: Record<SystemId, SystemConfig>;
  ai: AiConfig;
}

export interface AiConfig {
  provider: 'gemini';
  /** Never logged or sent to the browser. Null = AI tasks are switched off. */
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  /** Most data lookups the AI may make for one task (each one is an extra AI request). */
  maxToolRounds: number;
  /** Folder of plain-text business notes the AI reads (prices, policies, examples). */
  knowledgeDir: string;
}

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  /** system:read = the Systems team (Sam and Ivy): server health and security events. */
  /** ui:review = UI Review in the Development Studio (Aya, Kim and Rey look at page screenshots). */
  /** ai:usage = see the AI usage tracker; ai:limits = change its limits and prices. */
  /** catalog:write = add products to the online catalog with Kat. */
  admin: ['finance:read', 'orders:read', 'social:post', 'system:read', 'ui:review', 'ai:usage', 'ai:limits', 'catalog:write'],
  manager: ['finance:read', 'orders:read', 'ui:review', 'ai:usage'],
  finance: ['finance:read'],
  operations: ['orders:read'],
  /** Can post to the Facebook Page (with Carlo) and add catalog products (with Kat); no business data. */
  marketing: ['social:post', 'catalog:write'],
};

function int(v: string | undefined, def: number, min: number, max: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
}

function parseUsers(raw: string | undefined, problems: string[]): AppUser[] {
  if (!raw) return [];
  const out: AppUser[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    // username:role:scrypt$... — the hash itself never contains ':'
    const [username, role, ...rest] = entry.split(':');
    const passwordHash = rest.join(':');
    if (!username || !role || !passwordHash.startsWith('scrypt$')) {
      problems.push('An APP_USERS entry is malformed (expected username:role:hash).');
      continue;
    }
    if (!ROLE_PERMISSIONS[role]) {
      problems.push(`APP_USERS has an unknown role for user "${username}".`);
      continue;
    }
    out.push({ username, role, passwordHash });
  }
  return out;
}

export function validateBaseUrl(raw: string | undefined, allowed: Set<string>, allowInsecureLocal: boolean): { url: URL | null; problem?: string } {
  if (!raw) return { url: null, problem: 'Base URL is not set.' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { url: null, problem: 'Base URL is not a valid URL.' };
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(allowInsecureLocal && local && url.protocol === 'http:'))
    return { url: null, problem: 'Base URL must use https.' };
  if (url.username || url.password) return { url: null, problem: 'Base URL must not contain credentials.' };
  if (url.search || url.hash) return { url: null, problem: 'Base URL must not contain a query string or fragment.' };
  if (!allowed.has(url.hostname.toLowerCase())) return { url: null, problem: `Host ${url.hostname} is not in API_ALLOWED_HOSTS.` };
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return { url };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): { config: AppConfig; problems: string[] } {
  const problems: string[] = [];
  const production = env.NODE_ENV === 'production';
  const allowedHosts = new Set(
    (env.API_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  const allowInsecureLocal = !production && env.ALLOW_INSECURE_LOCAL_APIS === 'true';
  const users = parseUsers(env.APP_USERS, problems);
  if (users.length === 0) problems.push('No APP_USERS configured — nobody can sign in to Connected Mode.');

  const systems = {} as Record<SystemId, SystemConfig>;
  for (const [id, key, tokenKey] of [
    ['finance', 'FINANCE_API_BASE_URL', 'FINANCE_API_TOKEN'],
    ['orders', 'ORDERS_API_BASE_URL', 'ORDERS_API_TOKEN'],
  ] as const) {
    const { url, problem } = validateBaseUrl(env[key], allowedHosts, allowInsecureLocal);
    const token = env[tokenKey]?.trim() || null;
    const sysProblems = problem ? [`${key}: ${problem}`] : [];
    if (!token) sysProblems.push(`${tokenKey} is not set.`);
    systems[id] = { id, name: SYSTEM_NAMES[id], baseUrl: url, token, problems: sysProblems };
  }

  const config: AppConfig = {
    port: int(env.PORT, 8787, 1, 65535),
    host: env.HOST || '127.0.0.1',
    production,
    cookieSecure: env.APP_COOKIE_SECURE ? env.APP_COOKIE_SECURE === 'true' : production,
    sessionTtlMs: int(env.APP_SESSION_HOURS, 8, 1, 72) * 3600_000,
    appOrigin: env.APP_ORIGIN?.replace(/\/$/, '') || null,
    users,
    allowedHosts,
    allowInsecureLocal,
    timeoutMs: int(env.API_TIMEOUT_MS, 15000, 1000, 120000),
    maxRetries: int(env.API_MAX_RETRIES, 2, 0, 5),
    maxPages: int(env.API_MAX_PAGES, 50, 1, 500),
    maxConcurrentJobs: int(env.MAX_CONCURRENT_JOBS, 2, 1, 8),
    // Seconds between live checks (60 to 3600, default 120); LIVE_REFRESH_SECONDS=0 switches them off.
    liveRefreshMs: env.LIVE_REFRESH_SECONDS?.trim() === '0' ? 0 : int(env.LIVE_REFRESH_SECONDS, 120, 60, 3600) * 1000,
    maxRangeDays: int(env.REPORT_MAX_RANGE_DAYS, MAX_RANGE_DAYS, 1, MAX_RANGE_DAYS),
    taskLogFile: env.TASK_LOG_FILE === '' ? null : env.TASK_LOG_FILE || 'logs/tasks.jsonl',
    discussionsFile: env.DISCUSSIONS_FILE === undefined ? 'data/discussions.json' : env.DISCUSSIONS_FILE.trim() || null,
    uiReviewsFile: env.UI_REVIEWS_FILE === undefined ? 'data/ui-reviews.json' : env.UI_REVIEWS_FILE.trim() || null,
    tasksFile: env.TASKS_FILE === undefined ? 'data/tasks.json' : env.TASKS_FILE.trim() || null,
    aiUsageFile: env.AI_USAGE_FILE === undefined ? 'data/ai-usage.json' : env.AI_USAGE_FILE.trim() || null,
    aiLimits: aiLimits(env, problems),
    staticDir: env.STATIC_DIR || null,
    facebook: facebookConfig(env),
    catalog: catalogConfig(env),
    trustProxy: env.TRUST_PROXY === 'true',
    systems,
    ai: {
      provider: 'gemini',
      apiKey: env.GEMINI_API_KEY?.trim() || null,
      model: (env.GEMINI_MODEL?.trim() || 'gemini-flash-lite-latest').replace(/^models\//, ''),
      timeoutMs: int(env.AI_TIMEOUT_MS, 60000, 5000, 180000),
      maxToolRounds: int(env.AI_MAX_TOOL_ROUNDS, 3, 1, 6),
      knowledgeDir: env.KNOWLEDGE_DIR || 'knowledge',
    },
  };
  if (config.ai.apiKey && !/^[\w.-]+$/.test(config.ai.model)) {
    problems.push('GEMINI_MODEL has invalid characters; AI tasks are switched off.');
    config.ai.apiKey = null;
  }
  if (production && !config.cookieSecure) problems.push('APP_COOKIE_SECURE is false in production — sessions would travel over plain http.');
  return { config, problems };
}

/**
 * Default AI limits. Empty or "off" = no limit. Requests per day default to 500 so a mistake can
 * never run up thousands of requests; prices default to none (no cost estimate).
 */
function aiLimits(env: NodeJS.ProcessEnv, problems: string[]): AiLimits {
  const read = (key: string, def: number | null, max: number, whole: boolean): number | null => {
    const raw = env[key]?.trim();
    if (raw === undefined) return def;
    if (raw === '' || raw.toLowerCase() === 'off') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > max || (whole && !Number.isInteger(n))) {
      problems.push(`${key} must be ${whole ? 'a whole number' : 'a number'} from 0 to ${max} (or empty for no limit); using ${def ?? 'no limit'}.`);
      return def;
    }
    return n;
  };
  const warn = read('AI_USAGE_WARN_PERCENT', 80, 100, true);
  return {
    dailyRequests: read('AI_DAILY_REQUEST_LIMIT', 500, 100_000, true),
    userDailyRequests: read('AI_USER_DAILY_REQUEST_LIMIT', null, 100_000, true),
    dailyTokens: read('AI_DAILY_TOKEN_LIMIT', null, 1_000_000_000, true),
    monthlyBudgetUsd: read('AI_MONTHLY_BUDGET_USD', null, 100_000, false),
    inputUsdPerMillion: read('AI_PRICE_INPUT_USD_PER_M', null, 1_000, false),
    outputUsdPerMillion: read('AI_PRICE_OUTPUT_USD_PER_M', null, 1_000, false),
    warnPercent: warn !== null && warn >= 50 ? warn : 80,
  };
}

function facebookConfig(env: NodeJS.ProcessEnv): FacebookConfig {
  const pageId = env.FACEBOOK_PAGE_ID?.trim() || null;
  const token = env.FACEBOOK_PAGE_TOKEN?.trim() || null;
  const version = env.FACEBOOK_GRAPH_VERSION?.trim() || 'v27.0';
  const problems: string[] = [];
  if (!pageId) problems.push('FACEBOOK_PAGE_ID is not set.');
  else if (!/^\d{5,25}$/.test(pageId)) problems.push('FACEBOOK_PAGE_ID must be the numeric Page ID.');
  if (!token) problems.push('FACEBOOK_PAGE_TOKEN is not set.');
  if (!/^v\d{1,2}\.\d$/.test(version)) problems.push('FACEBOOK_GRAPH_VERSION must look like v27.0.');
  return { pageId: problems.length ? null : pageId, token: problems.length ? null : token, appSecret: env.FACEBOOK_APP_SECRET?.trim() || null, version, problems };
}

/**
 * The catalog repository. Defaults to WAD's catalog (Reinel2004/WAD-CATALOG on branch main, live at
 * wadfurniture-catalog.vercel.app); only the token must be set to switch it on.
 */
export function catalogConfig(env: NodeJS.ProcessEnv): CatalogConfig {
  const repo = env.CATALOG_GITHUB_REPO?.trim() || 'Reinel2004/WAD-CATALOG';
  const branch = env.CATALOG_GITHUB_BRANCH?.trim() || 'main';
  // WAD's repository keeps the site in its WAD-CATALOG folder; CATALOG_GITHUB_FOLDER= (empty) = top level.
  const folder = (env.CATALOG_GITHUB_FOLDER === undefined ? 'WAD-CATALOG' : env.CATALOG_GITHUB_FOLDER.trim()).replace(/^\/+|\/+$/g, '');
  const token = env.CATALOG_GITHUB_TOKEN?.trim() || null;
  const site = env.CATALOG_SITE_URL === undefined ? 'https://wadfurniture-catalog.vercel.app' : env.CATALOG_SITE_URL.trim();
  const problems: string[] = [];
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo) || repo.includes('..')) problems.push('CATALOG_GITHUB_REPO must look like owner/name.');
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) problems.push('CATALOG_GITHUB_BRANCH is not a valid branch name.');
  if (folder && (!/^[A-Za-z0-9._ -]+(\/[A-Za-z0-9._ -]+)*$/.test(folder) || folder.split('/').some((p) => p === '.' || p === '..')))
    problems.push('CATALOG_GITHUB_FOLDER must be a folder in the repository, like WAD-CATALOG.');
  if (!token) problems.push('CATALOG_GITHUB_TOKEN is not set.');
  else if (!/^[!-~]{20,255}$/.test(token)) problems.push('CATALOG_GITHUB_TOKEN does not look like a GitHub token.');
  let siteUrl: string | null = null;
  if (site) {
    try {
      const u = new URL(site);
      if (u.protocol !== 'https:' || u.username || u.password) throw new Error();
      siteUrl = u.origin + u.pathname.replace(/\/$/, '');
    } catch {
      problems.push('CATALOG_SITE_URL must be an https address.');
    }
  }
  const ok = !problems.length;
  return { repo: ok ? repo : null, branch, folder, token: ok ? token : null, siteUrl, problems };
}
