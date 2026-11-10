// AI usage tracker. GeminiClient asks it before EVERY request it sends (retries included):
// - begin() refuses the request when a limit is reached (code AI_LIMIT: nothing is sent, nothing
//   is billed), otherwise counts it at once, so requests running side by side cannot slip past a
//   request limit;
// - the returned finish() adds the outcome and the token counts Gemini reports.
// Only counts are kept: feature, agent, account name, model, outcome code, tokens, time. Never a
// prompt, an answer, a photo or a key. Totals are saved to a small JSON file (AI_USAGE_FILE) so a
// restart does not reset them; days are Manila calendar days.
//
// Cost is an ESTIMATE: tokens × the prices you set (US$ per 1 million tokens, from Google's price
// list for your model and tier). Google's billing page is the real bill. On the free tier the
// real cost is $0, and the request limits are what protect you.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AiFeature, AiLimitState, AiLimits, AiUsageDay, AiUsageGroup, AiUsageReport, AiUsageRow, AiUsageTotals, SessionUser } from '../../shared/live';
import { AI_LIMIT_BOUNDS } from '../../shared/live';
import { addDays, manilaDate } from '../../shared/manila';
import { IntegrationError } from '../http/errors';

export interface UsageTag {
  feature: AiFeature;
  agent?: string | null;
  user?: string | null;
}

export type UsageOutcome = { ok: true; usage: { promptTokens: number; outputTokens: number; totalTokens: number } | null } | { ok: false; code: string };

interface Group {
  requests: number;
  totalTokens: number;
  costMicros: number;
}

interface Bucket {
  requests: number;
  ok: number;
  failed: number;
  blocked: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  noUsage: number;
  /** Estimated cost in millionths of a US dollar (whole numbers: no rounding drift). */
  costMicros: number;
  /** Answered requests with token counts that ran while no prices were set. */
  unpriced: number;
  features: Record<string, Group>;
  agents: Record<string, Group>;
  users: Record<string, Group>;
}

interface FileShape {
  version: 1;
  limits: AiLimits | null;
  days: Record<string, Bucket>;
  recent: AiUsageRow[];
}

const KEEP_DAYS = 400;
const KEEP_ROWS = 100;
const SHOW_ROWS = 40;

export const NO_LIMITS: AiLimits = {
  dailyRequests: null,
  userDailyRequests: null,
  dailyTokens: null,
  monthlyBudgetUsd: null,
  inputUsdPerMillion: null,
  outputUsdPerMillion: null,
  warnPercent: 80,
};

const emptyBucket = (): Bucket => ({
  requests: 0,
  ok: 0,
  failed: 0,
  blocked: 0,
  promptTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  noUsage: 0,
  costMicros: 0,
  unpriced: 0,
  features: {},
  agents: {},
  users: {},
});

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Keeps only well-formed numbers from a saved bucket (the file could be edited or damaged). */
function cleanBucket(v: unknown): Bucket | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  const groups = (g: unknown) => {
    const out: Record<string, Group> = {};
    if (g && typeof g === 'object')
      for (const [k, x] of Object.entries(g as Record<string, unknown>).slice(0, 200)) {
        const y = (x ?? {}) as Record<string, unknown>;
        out[k.slice(0, 64)] = { requests: num(y.requests), totalTokens: num(y.totalTokens), costMicros: num(y.costMicros) };
      }
    return out;
  };
  return {
    requests: num(b.requests),
    ok: num(b.ok),
    failed: num(b.failed),
    blocked: num(b.blocked),
    promptTokens: num(b.promptTokens),
    outputTokens: num(b.outputTokens),
    totalTokens: num(b.totalTokens),
    noUsage: num(b.noUsage),
    costMicros: num(b.costMicros),
    unpriced: num(b.unpriced),
    features: groups(b.features),
    agents: groups(b.agents),
    users: groups(b.users),
  };
}

/**
 * Checks limits typed in the office. Every field must be present: null (no limit) or a number in
 * range. Request and token limits are whole numbers; 0 pauses the AI.
 */
export function validateLimits(input: unknown): { limits: AiLimits } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Send the limits as an object.' };
  const v = input as Record<string, unknown>;
  const field = (key: keyof AiLimits, max: number, whole: boolean, label: string): number | null | string => {
    const x = v[key];
    if (x === null || x === undefined || x === '') return null;
    if (typeof x !== 'number' || !Number.isFinite(x)) return `${label} must be a number or empty.`;
    if (x < 0 || x > max) return `${label} must be between 0 and ${max.toLocaleString('en-US')}.`;
    if (whole && !Number.isInteger(x)) return `${label} must be a whole number.`;
    return whole ? x : Math.round(x * 1_000_000) / 1_000_000;
  };
  const out: Record<string, number | null> = {};
  const specs: [keyof AiLimits, number, boolean, string][] = [
    ['dailyRequests', AI_LIMIT_BOUNDS.dailyRequests, true, 'Requests per day'],
    ['userDailyRequests', AI_LIMIT_BOUNDS.userDailyRequests, true, 'Requests per account per day'],
    ['dailyTokens', AI_LIMIT_BOUNDS.dailyTokens, true, 'Tokens per day'],
    ['monthlyBudgetUsd', AI_LIMIT_BOUNDS.monthlyBudgetUsd, false, 'Monthly budget'],
    ['inputUsdPerMillion', AI_LIMIT_BOUNDS.pricePerMillion, false, 'Input price'],
    ['outputUsdPerMillion', AI_LIMIT_BOUNDS.pricePerMillion, false, 'Output price'],
  ];
  for (const [key, max, whole, label] of specs) {
    const r = field(key, max, whole, label);
    if (typeof r === 'string') return { error: r };
    out[key] = r;
  }
  const w = v.warnPercent;
  if (typeof w !== 'number' || !Number.isInteger(w) || w < 50 || w > 100) return { error: 'Warn at must be a whole number from 50 to 100 (percent).' };
  return { limits: { ...(out as unknown as AiLimits), warnPercent: w } };
}

export class AiUsageMeter {
  private days: Record<string, Bucket> = {};
  private recent: AiUsageRow[] = [];
  private custom: AiLimits | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private warned = new Set<string>();

  constructor(
    private opts: {
      file: string | null;
      defaults: AiLimits;
      model: string | null;
      now?: () => Date;
      log?: (line: string) => void;
      /** Delay before writing the file after a change (ms); 0 writes at once (tests). */
      saveDelayMs?: number;
    },
  ) {
    this.load();
  }

  get limits(): AiLimits {
    return this.custom ?? this.opts.defaults;
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  private bucket(date: string) {
    return (this.days[date] ??= emptyBucket());
  }

  private monthCostMicros(month: string) {
    let c = 0;
    for (const [d, b] of Object.entries(this.days)) if (d.startsWith(month)) c += b.costMicros;
    return c;
  }

  private priced(l = this.limits) {
    return l.inputUsdPerMillion !== null && l.outputUsdPerMillion !== null;
  }

  /**
   * Called just before a request is sent. Throws AI_LIMIT when a limit is reached (the request
   * is NOT sent); otherwise counts it and returns the function that records how it ended.
   */
  begin(tag: UsageTag & { model: string }): (o: UsageOutcome) => void {
    const at = this.now();
    const date = manilaDate(at);
    const day = this.bucket(date);
    const l = this.limits;
    const user = tag.user?.slice(0, 64) || null;
    const agent = tag.agent?.slice(0, 32) || null;
    const reason = this.blockReason(date, day, user, l);
    if (reason) {
      day.blocked++;
      this.addRow({ at: at.toISOString(), feature: tag.feature, agent, user, model: tag.model, outcome: 'blocked', promptTokens: null, outputTokens: null, totalTokens: null, costUsd: null, ms: null });
      this.scheduleSave();
      if (!this.warned.has(`block|${date}|${reason.id}`)) {
        this.warned.add(`block|${date}|${reason.id}`);
        this.opts.log?.(`[ai-usage] limit reached (${reason.id}); AI requests are refused until it resets or an admin raises it`);
      }
      throw new IntegrationError('AI_LIMIT', reason.message, undefined, 429);
    }
    day.requests++;
    const groups: [Record<string, Group>, string | null][] = [
      [day.features, tag.feature],
      [day.agents, agent],
      [day.users, user],
    ];
    for (const [g, k] of groups) if (k) (g[k] ??= { requests: 0, totalTokens: 0, costMicros: 0 }).requests++;
    this.scheduleSave();
    const started = Date.now();
    let finished = false;
    return (o) => {
      if (finished) return;
      finished = true;
      let cost: number | null = null;
      let usage: { promptTokens: number; outputTokens: number; totalTokens: number } | null = null;
      if (o.ok) {
        day.ok++;
        usage = o.usage;
        if (!usage) day.noUsage++;
        else {
          day.promptTokens += usage.promptTokens;
          day.outputTokens += usage.outputTokens;
          day.totalTokens += usage.totalTokens;
          // The prices in force when the request ran (changing them later does not rewrite history).
          const now = this.limits;
          if (this.priced(now)) cost = Math.round(usage.promptTokens * now.inputUsdPerMillion! + usage.outputTokens * now.outputUsdPerMillion!);
          else day.unpriced++;
          day.costMicros += cost ?? 0;
          for (const [g, k] of groups)
            if (k && g[k]) {
              g[k].totalTokens += usage.totalTokens;
              g[k].costMicros += cost ?? 0;
            }
        }
      } else day.failed++;
      this.addRow({
        at: at.toISOString(),
        feature: tag.feature,
        agent,
        user,
        model: tag.model,
        outcome: o.ok ? 'ok' : o.code,
        promptTokens: usage?.promptTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
        costUsd: cost === null ? null : cost / 1_000_000,
        ms: Date.now() - started,
      });
      this.warnIfNear(date);
      this.scheduleSave();
    };
  }

  private blockReason(date: string, day: Bucket, user: string | null, l: AiLimits): { id: AiLimitState['id']; message: string } | null {
    const who = 'An admin can change it in the Systems tab (AI usage).';
    if (l.dailyRequests !== null && day.requests >= l.dailyRequests)
      return { id: 'dailyRequests', message: `The office's AI limit of ${l.dailyRequests} requests per day is reached. It resets at midnight (Manila time). ${who}` };
    if (l.userDailyRequests !== null && user && (day.users[user]?.requests ?? 0) >= l.userDailyRequests)
      return { id: 'userDailyRequests', message: `Your account reached its AI limit of ${l.userDailyRequests} requests today. It resets at midnight (Manila time). ${who}` };
    if (l.dailyTokens !== null && day.totalTokens >= l.dailyTokens)
      return { id: 'dailyTokens', message: `The office's AI limit of ${l.dailyTokens.toLocaleString('en-US')} tokens per day is reached. It resets at midnight (Manila time). ${who}` };
    if (l.monthlyBudgetUsd !== null && this.priced(l) && this.monthCostMicros(date.slice(0, 7)) >= l.monthlyBudgetUsd * 1_000_000)
      return { id: 'monthlyBudgetUsd', message: `The office's AI budget of US$${l.monthlyBudgetUsd} for this month is used up (estimated). It resets on the 1st. ${who}` };
    return null;
  }

  private warnIfNear(date: string) {
    for (const s of this.states(date, null)) {
      if (s.level !== 'warning') continue;
      const k = `warn|${date.slice(0, s.id === 'monthlyBudgetUsd' ? 7 : 10)}|${s.id}`;
      if (this.warned.has(k)) continue;
      this.warned.add(k);
      this.opts.log?.(`[ai-usage] ${s.label}: ${Math.floor(s.percent ?? 0)}% used`);
    }
  }

  private addRow(r: AiUsageRow) {
    this.recent.unshift(r);
    if (this.recent.length > KEEP_ROWS) this.recent.length = KEEP_ROWS;
  }

  private states(date: string, user: string | null): AiLimitState[] {
    const l = this.limits;
    const day = this.days[date] ?? emptyBucket();
    const state = (id: AiLimitState['id'], label: string, used: number, limit: number | null): AiLimitState => {
      const percent = limit === null ? null : limit === 0 ? 100 : Math.round((used / limit) * 1000) / 10;
      const level = limit === null ? 'ok' : used >= limit ? 'reached' : percent !== null && percent >= l.warnPercent ? 'warning' : 'ok';
      return { id, label, used, limit, percent, level };
    };
    const out = [state('dailyRequests', 'Requests today', day.requests, l.dailyRequests), state('dailyTokens', 'Tokens today', day.totalTokens, l.dailyTokens)];
    if (user !== null) out.splice(1, 0, state('userDailyRequests', 'Your requests today', day.users[user]?.requests ?? 0, l.userDailyRequests));
    out.push(state('monthlyBudgetUsd', 'Estimated cost this month (US$)', this.monthCostMicros(date.slice(0, 7)) / 1_000_000, this.priced(l) ? l.monthlyBudgetUsd : null));
    return out;
  }

  private totals(buckets: Bucket[]): AiUsageTotals {
    const t = buckets.reduce(
      (a, b) => {
        a.requests += b.requests;
        a.ok += b.ok;
        a.failed += b.failed;
        a.blocked += b.blocked;
        a.promptTokens += b.promptTokens;
        a.outputTokens += b.outputTokens;
        a.totalTokens += b.totalTokens;
        a.noUsage += b.noUsage;
        a.costMicros += b.costMicros;
        a.unpriced += b.unpriced;
        return a;
      },
      { requests: 0, ok: 0, failed: 0, blocked: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0, noUsage: 0, costMicros: 0, unpriced: 0 },
    );
    // No cost at all when nothing in the period was priced and no prices are set now.
    const known = t.costMicros > 0 || this.priced() || t.ok - t.noUsage - t.unpriced > 0;
    return {
      requests: t.requests,
      ok: t.ok,
      failed: t.failed,
      blocked: t.blocked,
      promptTokens: t.promptTokens,
      outputTokens: t.outputTokens,
      totalTokens: t.totalTokens,
      noUsage: t.noUsage,
      costUsd: known ? t.costMicros / 1_000_000 : null,
    };
  }

  private groups(buckets: Bucket[], pick: (b: Bucket) => Record<string, Group>, costKnown: boolean): AiUsageGroup[] {
    const m = new Map<string, Group>();
    for (const b of buckets)
      for (const [k, g] of Object.entries(pick(b))) {
        const x = m.get(k) ?? { requests: 0, totalTokens: 0, costMicros: 0 };
        x.requests += g.requests;
        x.totalTokens += g.totalTokens;
        x.costMicros += g.costMicros;
        m.set(k, x);
      }
    return [...m]
      .map(([key, g]) => ({ key, requests: g.requests, totalTokens: g.totalTokens, costUsd: costKnown ? g.costMicros / 1_000_000 : null }))
      .sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key))
      .slice(0, 30);
  }

  report(user: SessionUser): AiUsageReport {
    const now = this.now();
    const today = manilaDate(now);
    const month = today.slice(0, 7);
    const monthBuckets = Object.entries(this.days)
      .filter(([d]) => d.startsWith(month))
      .map(([, b]) => b);
    const monthTotals = this.totals(monthBuckets);
    const days: AiUsageDay[] = [];
    for (let i = 29; i >= 0; i--) {
      const date = addDays(today, -i);
      days.push({ date, ...this.totals([this.days[date] ?? emptyBucket()]) });
    }
    const l = this.limits;
    const notes = [
      'Requests are counted when they are sent to Gemini, including ones that failed; "blocked" ones were stopped by a limit and never sent.',
      'Tokens are the counts Gemini reports with each answer (input includes photos and screenshots; output includes the model\'s thinking).',
      this.priced()
        ? 'Cost is an estimate from the prices set here, at the time each request ran. Your real bill is on Google Cloud / AI Studio billing; on the free tier it is US$0.'
        : 'No prices are set, so no cost is estimated. Copy your model\'s prices (US$ per 1 million input and output tokens) from Google\'s Gemini API pricing page to see an estimate and use a monthly budget.',
    ];
    if (l.monthlyBudgetUsd !== null && !this.priced()) notes.push('The monthly budget is not enforced until both prices are set.');
    const unpriced = monthBuckets.reduce((a, b) => a + b.unpriced, 0);
    if (unpriced && this.priced()) notes.push(`${unpriced} request(s) this month ran before prices were set and are not in the cost.`);
    if (l.dailyTokens !== null) notes.push('Token limits are checked before each request, so the one request that crosses the limit still finishes.');
    if (!this.opts.file) notes.push('Totals are kept in memory only (AI_USAGE_FILE is empty) and reset when the server restarts.');
    return {
      asOf: now.toISOString(),
      model: this.opts.model,
      today,
      month,
      todayTotals: this.totals([this.days[today] ?? emptyBucket()]),
      monthTotals,
      days,
      byFeature: this.groups(monthBuckets, (b) => b.features, monthTotals.costUsd !== null),
      byAgent: this.groups(monthBuckets, (b) => b.agents, monthTotals.costUsd !== null),
      byUser: this.groups(monthBuckets, (b) => b.users, monthTotals.costUsd !== null),
      recent: this.recent.slice(0, SHOW_ROWS),
      limits: l,
      defaults: this.opts.defaults,
      customized: this.custom !== null,
      limitStates: this.states(today, user.username),
      yourRequestsToday: this.days[today]?.users[user.username]?.requests ?? 0,
      saved: !!this.opts.file,
      canEdit: user.permissions.includes('ai:limits'),
      notes,
    };
  }

  /** Today's limits as they stand (for the Attention list); `user` adds that account's own limit. */
  limitStates(user: string | null): AiLimitState[] {
    return this.states(manilaDate(this.now()), user);
  }

  /** A short summary for the Systems team (Sam). */
  summary() {
    const today = manilaDate(this.now());
    const t = this.totals([this.days[today] ?? emptyBucket()]);
    const m = this.totals(Object.entries(this.days).filter(([d]) => d.startsWith(today.slice(0, 7))).map(([, b]) => b));
    return {
      today: { requests: t.requests, failed: t.failed, blocked: t.blocked, totalTokens: t.totalTokens, estimatedCostUsd: t.costUsd },
      thisMonth: { requests: m.requests, totalTokens: m.totalTokens, estimatedCostUsd: m.costUsd },
      limits: this.states(today, null).map((s) => ({ limit: s.label, used: s.used, max: s.limit, level: s.level })),
    };
  }

  /** null = back to the server's defaults. */
  setLimits(l: AiLimits | null) {
    this.custom = l;
    this.warned.clear();
    this.save();
  }

  private load() {
    const f = this.opts.file;
    if (!f || !existsSync(f)) return;
    try {
      const v = JSON.parse(readFileSync(f, 'utf8')) as Partial<FileShape>;
      if (v.days && typeof v.days === 'object')
        for (const [d, b] of Object.entries(v.days)) {
          const c = /^\d{4}-\d{2}-\d{2}$/.test(d) ? cleanBucket(b) : null;
          if (c) this.days[d] = c;
        }
      if (Array.isArray(v.recent)) this.recent = v.recent.filter((r) => r && typeof r === 'object' && typeof r.at === 'string').slice(0, KEEP_ROWS);
      if (v.limits) {
        const ok = validateLimits(v.limits);
        if ('limits' in ok) this.custom = ok.limits;
      }
    } catch {
      this.opts.log?.('[ai-usage] the usage file could not be read; starting from zero');
    }
  }

  private scheduleSave() {
    if (!this.opts.file || this.saveTimer) return;
    const delay = this.opts.saveDelayMs ?? 2000;
    if (delay === 0) return this.save();
    this.saveTimer = setTimeout(() => this.save(), delay);
    this.saveTimer.unref?.();
  }

  /** Writes the file now (also on shutdown). */
  save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const f = this.opts.file;
    if (!f) return;
    const oldest = addDays(manilaDate(this.now()), -KEEP_DAYS);
    for (const d of Object.keys(this.days)) if (d < oldest) delete this.days[d];
    try {
      mkdirSync(dirname(f), { recursive: true });
      const data: FileShape = { version: 1, limits: this.custom, days: this.days, recent: this.recent };
      writeFileSync(`${f}.tmp`, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
      renameSync(`${f}.tmp`, f);
    } catch {
      /* a storage problem must not stop AI work; totals stay correct in memory */
    }
  }
}
