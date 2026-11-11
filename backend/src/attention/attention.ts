// "Attention needed": one list of what someone should look at, built by code from what the
// server already knows. Nothing here calls the AI, and the only outside read is the open-orders
// list (shared with the Workshop's live check, so normally no extra request).
//   - connections: a business system, Gemini or Facebook not set up, or its recent calls failing
//   - limits:      an AI usage limit reached (or close)
//   - blocked:     this user's own tasks, discussions and UI Reviews that failed (last 7 days)
//   - overdue:     open orders past their due date (most overdue first), linked to their page in
//                  WAD Order Management
// Every item is filtered by the user's permissions, exactly like the records it points to.

import type { AiStatus, AttentionItem, AttentionReport, AttentionSeverity, Discussion, Job, SessionUser, SystemStatus, UiReview } from '../../shared/live';
import { daysBetween, manilaDate } from '../../shared/manila';
import type { OrderRecord } from '../adapters/types';
import type { AiUsageMeter } from '../ai/usage';
import type { HealthLog, HealthSystem } from '../monitor/monitor';

export const ATTENTION_LIMITS = {
  /** Failed work older than this is not shown. */
  recentDays: 7,
  /** A connection failure older than this (with nothing since) is not shown. */
  failureFreshMinutes: 60,
  maxBlocked: 20,
  maxOverdue: 30,
  /** Overdue by more than this many days is critical. */
  criticalOverdueDays: 7,
};

export interface AttentionDeps {
  systems: () => SystemStatus[];
  health?: HealthLog | null;
  aiStatus: () => AiStatus;
  /** Facebook's setup problems, or [] when it is ready. */
  facebookProblems: () => string[];
  jobs: (u: SessionUser) => Job[];
  discussions?: (u: SessionUser) => Discussion[];
  uiReviews?: (u: SessionUser) => UiReview[];
  aiUsage?: AiUsageMeter | null;
  /** Open orders (cached by the caller); `error` when they could not be read. */
  openOrders: () => Promise<{ orders: OrderRecord[] | null; error: string | null }>;
  /** WAD Order Management's web address (ends with "/"), for links to an order's page; null = no links. */
  ordersWebUrl: string | null;
  now?: () => Date;
}

const RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };
const KIND_RANK = { connection: 0, limit: 1, blocked: 2, overdue: 3 } as const;

/** What a failed call's status usually means, in plain words. */
function failureHint(status: string | number | undefined): string {
  if (status === 401 || status === 403) return 'The access token was refused (wrong or expired). Update it on the server.';
  if (status === 429) return 'Too many requests: the system is limiting us. It usually clears by itself.';
  if (status === 'TIMEOUT') return 'The system did not answer in time.';
  if (status === 'NETWORK') return 'The system could not be reached (network or the site is down).';
  if (typeof status === 'number' && status >= 500) return 'The system had an error on its side.';
  if (typeof status === 'number' && status >= 300 && status < 400) return 'The system answered with a redirect, which the office refuses.';
  return 'Check the Systems tab for details.';
}

export async function buildAttention(user: SessionUser, deps: AttentionDeps): Promise<AttentionReport> {
  const now = deps.now?.() ?? new Date();
  const today = manilaDate(now);
  const can = (p: string) => user.permissions.includes(p as never);
  const items: AttentionItem[] = [];
  const notes: string[] = [];
  const systemsLink = { kind: 'systems' as const, label: 'Open the Systems tab' };

  // ---------------------------------------------------------------- connections
  const NAMES: Record<HealthSystem, string> = { orders: 'WAD Order Management', finance: 'WAD Furniture Management', gemini: 'Gemini (AI)', facebook: 'Facebook Page' };
  const failing = (sys: HealthSystem) => {
    const h = deps.health?.summary(sys);
    if (!h || !h.failuresInARowNow || !h.lastFailure) return;
    const ageMin = (now.getTime() - Date.parse(h.lastFailure.at)) / 60_000;
    if (ageMin > ATTENTION_LIMITS.failureFreshMinutes) return;
    const status = h.lastFailure.status;
    items.push({
      id: `conn-fail:${sys}`,
      version: h.lastFailure.at,
      kind: 'connection',
      severity: h.failuresInARowNow >= 3 ? 'critical' : 'warning',
      title: `${NAMES[sys]}: the last ${h.failuresInARowNow === 1 ? 'request' : `${h.failuresInARowNow} requests`} failed`,
      detail: `${typeof status === 'number' ? `HTTP ${status}` : status}. ${failureHint(status)}`,
      at: h.lastFailure.at,
      link: systemsLink,
    });
  };
  for (const s of deps.systems()) {
    if (!can(s.id === 'orders' ? 'orders:read' : 'finance:read')) continue;
    if (s.state !== 'ready')
      items.push({
        id: `conn-setup:${s.id}`,
        version: `${s.state}|${s.problems.join('|')}`,
        kind: 'connection',
        severity: 'warning',
        title: `${s.name} is not connected`,
        detail: s.problems[0] ?? (s.state === 'awaiting_documentation' ? 'Waiting for its API documentation.' : 'Not configured on the server.'),
        at: null,
        link: systemsLink,
      });
    else failing(s.id);
  }
  const ai = deps.aiStatus();
  if (!ai.ready)
    items.push({ id: 'conn-setup:gemini', version: ai.problems.join('|'), kind: 'connection', severity: 'warning', title: 'AI is not set up', detail: ai.problems[0] ?? 'GEMINI_API_KEY is not set.', at: null, link: systemsLink });
  else failing('gemini');
  if (can('social:post')) {
    const fb = deps.facebookProblems();
    if (fb.length)
      items.push({ id: 'conn-setup:facebook', version: fb.join('|'), kind: 'connection', severity: 'info', title: 'Facebook posting is not set up', detail: fb[0], at: null, link: null });
    else failing('facebook');
  }

  // ---------------------------------------------------------------- AI limits
  if (deps.aiUsage) {
    for (const s of deps.aiUsage.limitStates(user.username)) {
      if (s.level === 'ok') continue;
      // Everyone hears when they are blocked; only those who can see usage also get the warnings.
      if (s.level === 'warning' && !can('ai:usage')) continue;
      const money = s.id === 'monthlyBudgetUsd';
      const used = money ? `US$${s.used.toFixed(2)}` : s.used.toLocaleString('en-US');
      const max = money ? `US$${(s.limit ?? 0).toFixed(2)}` : (s.limit ?? 0).toLocaleString('en-US');
      items.push({
        id: `limit:${s.id}`,
        version: `${today.slice(0, money ? 7 : 10)}|${s.level}`,
        kind: 'limit',
        severity: s.level === 'reached' ? 'critical' : 'warning',
        title: s.level === 'reached' ? `AI limit reached: ${s.label.replace(' (US$)', '').toLowerCase()}` : `AI usage near its limit: ${s.label.replace(' (US$)', '').toLowerCase()}`,
        detail: `${used} of ${max}. ${s.level === 'reached' ? 'New AI requests are refused until it resets' + (can('ai:limits') ? ' or you raise it.' : '; ask an admin to raise it.') : `Over ${deps.aiUsage.limits.warnPercent}% used.`}`,
        at: null,
        link: can('ai:usage') ? { kind: 'systems', label: 'Open AI usage' } : null,
      });
    }
  }

  // ---------------------------------------------------------------- blocked / failed work (own)
  const since = now.getTime() - ATTENTION_LIMITS.recentDays * 86_400_000;
  const recent = (iso: string | null | undefined) => !!iso && Date.parse(iso) >= since;
  const blocked: AttentionItem[] = [];
  for (const j of deps.jobs(user)) {
    // An agent waiting for your answer is blocked on you.
    if (j.status === 'needs_info' && recent(j.finishedAt ?? j.createdAt)) {
      blocked.push({
        id: `job-info:${j.id}`,
        version: j.finishedAt ?? j.createdAt,
        kind: 'blocked',
        severity: 'info',
        title: `Waiting for your answer: ${j.title}`,
        detail: 'The agent needs more information before it can finish. Reply in the task.',
        at: j.finishedAt ?? j.createdAt,
        link: { kind: 'job', id: j.id, label: 'Open the task' },
      });
      continue;
    }
    if (j.status !== 'failed' || !recent(j.finishedAt ?? j.createdAt)) continue;
    const err = j.error ?? j.steps.find((s) => s.status === 'failed')?.error;
    const limit = err?.code === 'AI_LIMIT';
    blocked.push({
      id: `job:${j.id}`,
      version: j.id,
      kind: 'blocked',
      severity: limit || err?.code === 'AUTH_FAILED' ? 'critical' : 'warning',
      title: `${j.type === 'ai.task' ? 'Task' : 'Report'} ${limit ? 'blocked' : 'failed'}: ${j.title}`,
      detail: err?.message ?? 'See the details.',
      at: j.finishedAt ?? j.createdAt,
      link: { kind: 'job', id: j.id, label: j.type === 'ai.task' ? 'Open the task' : 'Open the report' },
    });
  }
  for (const d of deps.discussions?.(user) ?? []) {
    if (d.status !== 'failed' || !recent(d.finishedAt ?? d.updatedAt)) continue;
    blocked.push({
      id: `discussion:${d.id}`,
      version: d.updatedAt,
      kind: 'blocked',
      severity: 'warning',
      title: `Team discussion failed: ${d.topic}`,
      detail: d.error ?? 'See the discussion.',
      at: d.finishedAt ?? d.updatedAt,
      link: { kind: 'discussion', id: d.id, label: 'Open the discussion' },
    });
  }
  for (const r of deps.uiReviews?.(user) ?? []) {
    // A failed review, or a failed re-check (the review goes back to its plan with an error).
    if (!(r.status === 'failed' || (r.error && (r.status === 'proposed' || r.status === 'verified'))) || !recent(r.updatedAt)) continue;
    blocked.push({
      id: `uireview:${r.id}`,
      version: r.updatedAt,
      kind: 'blocked',
      severity: 'warning',
      title: `UI Review ${r.status === 'failed' ? 'failed' : 're-check failed'}: ${r.page}`,
      detail: r.error ?? 'See the review.',
      at: r.updatedAt,
      link: { kind: 'uireview', id: r.id, label: 'Open the review' },
    });
  }
  blocked.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  if (blocked.length > ATTENTION_LIMITS.maxBlocked) notes.push(`Showing the latest ${ATTENTION_LIMITS.maxBlocked} of ${blocked.length} failed items.`);
  items.push(...blocked.slice(0, ATTENTION_LIMITS.maxBlocked));

  // ---------------------------------------------------------------- overdue orders
  let overdueTotal: number | null = null;
  if (can('orders:read')) {
    const { orders, error } = await deps.openOrders();
    if (error) notes.push(`Overdue orders could not be checked: ${error}`);
    if (orders) {
      const overdue = orders
        .filter((o) => o.isClosed === false && o.dueDate !== null && o.dueDate < today)
        .map((o) => ({ o, days: daysBetween(o.dueDate!, today) }))
        .sort((a, b) => b.days - a.days || a.o.ref.localeCompare(b.o.ref));
      overdueTotal = overdue.length;
      const unknown = orders.filter((o) => o.isClosed === null || (o.isClosed === false && o.dueDate === null)).length;
      if (unknown) notes.push(`${unknown} open order(s) have no due date or an unknown status, so they could not be checked.`);
      if (overdue.length > ATTENTION_LIMITS.maxOverdue) notes.push(`Showing the ${ATTENTION_LIMITS.maxOverdue} most overdue of ${overdue.length} orders (the Overdue orders report lists all).`);
      if (!deps.ordersWebUrl) notes.push('Links to orders are off: the order system address is not set.');
      else if (overdue.some(({ o }) => !o.recordId)) notes.push('Some orders have no link yet: upload the updated api/ceo/office-orders.php to WAD Order Management.');
      for (const { o, days } of overdue.slice(0, ATTENTION_LIMITS.maxOverdue)) {
        const done = o.progressPercent !== null ? ` · ${o.progressPercent}% of pieces done` : '';
        items.push({
          id: `overdue:${o.ref}`,
          // Comes back after a dismiss when the due date, status or stage changes.
          version: `${o.dueDate}|${o.status}|${o.stage ?? ''}`,
          kind: 'overdue',
          severity: days > ATTENTION_LIMITS.criticalOverdueDays ? 'critical' : 'warning',
          title: `${o.ref}${o.customerName ? ` (${o.customerName})` : ''} is ${days} day${days === 1 ? '' : 's'} overdue`,
          detail: `Due ${o.dueDate} · ${o.status}${o.stage ? ` · ${o.stage}` : ''}${done}`,
          at: o.dueDate,
          link:
            deps.ordersWebUrl && o.recordId
              ? { kind: 'external', url: `${deps.ordersWebUrl}view_order.php?id=${o.recordId}`, label: 'Open in WAD Order Management' }
              : null,
        });
      }
    }
  }

  items.sort((a, b) => RANK[a.severity] - RANK[b.severity] || KIND_RANK[a.kind] - KIND_RANK[b.kind] || (b.at ?? '').localeCompare(a.at ?? ''));
  return { asOf: now.toISOString(), items, overdueTotal, notes };
}

/** WAD Order Management's web address from its API base ("https://host/api/" → "https://host/"). */
export function ordersWebUrl(apiBase: URL | null): string | null {
  if (!apiBase) return null;
  const u = new URL(apiBase.href);
  u.pathname = u.pathname.replace(/api\/?$/, '');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.href;
}
