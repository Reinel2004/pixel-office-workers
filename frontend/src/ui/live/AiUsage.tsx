// AI usage tracker (Systems tab, admin and manager accounts): requests actually sent to Gemini,
// the tokens Gemini reported, an estimated cost from the prices set here, and the limits that
// stop requests before they are sent. Admins can change the limits; everything is server-side.

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AiLimitState, AiLimits, AiUsageDay, AiUsageGroup, AiUsageReport } from '../../../shared/live';
import { AI_FEATURE_LABEL } from '../../../shared/live';
import { formatManila } from '../../../shared/manila';
import { AGENT_BY_ID } from '../../agents/roster';
import type { AgentId } from '../../sim/types';
import type { LiveStore } from '../../live/store';

const REFRESH_MS = 20_000;
const useLive = (store: LiveStore) => useSyncExternalStore(store.subscribe, store.getVersion);

const int = (n: number) => n.toLocaleString('en-US');
const usd = (v: number | null) => (v === null ? '—' : v === 0 ? 'US$0' : v < 0.01 ? `US$${v.toFixed(4)}` : `US$${v.toFixed(2)}`);
const agentName = (k: string) => AGENT_BY_ID[k as AgentId]?.name ?? k;
const featureName = (k: string) => AI_FEATURE_LABEL[k as keyof typeof AI_FEATURE_LABEL] ?? k;
const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });

export function AiUsagePanel({ store }: { store: LiveStore }) {
  useLive(store);
  const allowed = store.canSeeAiUsage();
  // Load when shown, then refresh while the tab is visible (one small request every 20 s).
  useEffect(() => {
    if (!allowed) return;
    void store.loadAiUsage();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void store.loadAiUsage();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [allowed, store]);

  if (!allowed) return null;
  const u = store.aiUsage;
  return (
    <article className="output usage">
      <header>
        <b>AI usage</b>
        <span className="row gap-s">
          {u?.model && <span className="chip status-interrupted">{u.model}</span>}
          <button className="btn sm ghost" onClick={() => void store.loadAiUsage()} title="Refresh now">
            Refresh
          </button>
        </span>
      </header>
      {store.aiUsageError && <p className="photo-note small">{store.aiUsageError}</p>}
      {!u ? (
        <p className="muted small">Loading AI usage…</p>
      ) : (
        <>
          <p className="muted small">
            Updated {formatManila(u.asOf)} · days are Manila time{u.saved ? '' : ' · kept in memory only (resets on restart)'}
          </p>
          <Limits states={u.limitStates} />
          <div className="usage-tiles">
            <Tile label="Requests today" value={int(u.todayTotals.requests)} sub={`${u.todayTotals.failed} failed · ${u.todayTotals.blocked} blocked`} />
            <Tile label="Tokens today" value={int(u.todayTotals.totalTokens)} sub={`${int(u.todayTotals.promptTokens)} in · ${int(u.todayTotals.outputTokens)} out`} />
            <Tile label="Requests this month" value={int(u.monthTotals.requests)} sub={`${int(u.monthTotals.totalTokens)} tokens`} />
            <Tile label="Est. cost this month" value={usd(u.monthTotals.costUsd)} sub={u.monthTotals.costUsd === null ? 'no prices set' : 'estimate, not the bill'} />
          </div>
          <DayChart days={u.days} />
          <Groups title="By feature (this month)" items={u.byFeature} name={featureName} />
          <Groups title="By team member (this month)" items={u.byAgent} name={agentName} />
          <Groups title="By account (this month)" items={u.byUser} name={(k) => k} />
          <Recent u={u} />
          {u.canEdit ? <LimitsForm store={store} u={u} /> : <p className="muted small">Only admin accounts can change the limits.</p>}
          <ul className="mini-list">
            {u.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="usage-tile">
      <span>{label}</span>
      <b>{value}</b>
      <small>{sub}</small>
    </div>
  );
}

const LEVEL_TEXT: Record<AiLimitState['level'], string> = { ok: '', warning: 'Near the limit', reached: 'Limit reached' };

function Limits({ states }: { states: AiLimitState[] }) {
  return (
    <div className="usage-limits">
      {states.map((s) => {
        const money = s.id === 'monthlyBudgetUsd';
        const used = money ? usd(s.used) : int(s.used);
        const limit = s.limit === null ? (money ? 'no budget (or no prices)' : 'no limit') : money ? usd(s.limit) : int(s.limit);
        return (
          <div key={s.id} className={`usage-limit lv-${s.level}`}>
            <div className="row between small">
              <span>{s.label.replace(' (US$)', '')}</span>
              <span>
                <b>{used}</b> / {limit}
                {LEVEL_TEXT[s.level] && <em> · {LEVEL_TEXT[s.level]}</em>}
              </span>
            </div>
            {s.limit !== null && (
              <div className="usage-bar" role="meter" aria-label={s.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, s.percent ?? 0)}>
                <i style={{ width: `${Math.min(100, s.percent ?? 0)}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Requests per day for the last 30 days (one series: no legend; hover or focus a bar for details). */
function DayChart({ days }: { days: AiUsageDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.requests));
  const shown = hover === null ? days.length - 1 : hover;
  const d = days[shown];
  return (
    <div className="usage-chart">
      <div className="row between small">
        <b>Requests per day · last 30 days</b>
        <span className="muted">max {int(max)}</span>
      </div>
      <p className="usage-chart-read small" aria-live="polite">
        <b>{hover === null ? 'Today' : shortDate(d.date)}</b>: {int(d.requests)} request{d.requests === 1 ? '' : 's'} · {int(d.totalTokens)} tokens
        {d.costUsd !== null ? ` · ${usd(d.costUsd)}` : ''}
        {d.failed ? ` · ${d.failed} failed` : ''}
        {d.blocked ? ` · ${d.blocked} blocked` : ''}
      </p>
      <div className="usage-bars" onMouseLeave={() => setHover(null)}>
        {days.map((x, i) => (
          <button
            key={x.date}
            type="button"
            className={`usage-col${i === shown ? ' on' : ''}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            aria-label={`${shortDate(x.date)}: ${x.requests} requests, ${x.totalTokens} tokens`}
          >
            <i style={{ height: x.requests ? `${Math.max(4, (x.requests / max) * 100)}%` : 0 }} />
          </button>
        ))}
      </div>
      <div className="row between small muted">
        <span>{shortDate(days[0].date)}</span>
        <span>Today</span>
      </div>
      <details className="small">
        <summary>Show as a table</summary>
        <table className="usage-table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Requests</th>
              <th>Tokens</th>
              <th>Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {[...days].reverse().map((x) => (
              <tr key={x.date}>
                <td>{x.date}</td>
                <td>{int(x.requests)}</td>
                <td>{int(x.totalTokens)}</td>
                <td>{usd(x.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function Groups({ title, items, name }: { title: string; items: AiUsageGroup[]; name: (k: string) => string }) {
  if (!items.length) return null;
  return (
    <div>
      <b className="small">{title}</b>
      <div className="kv">
        {items.map((g) => (
          <div key={g.key}>
            <span>{name(g.key)}</span>
            <b>
              {int(g.requests)} req · {int(g.totalTokens)} tok{g.costUsd !== null ? ` · ${usd(g.costUsd)}` : ''}
            </b>
          </div>
        ))}
      </div>
    </div>
  );
}

function Recent({ u }: { u: AiUsageReport }) {
  if (!u.recent.length) return <p className="muted small">No AI requests yet.</p>;
  return (
    <details className="small">
      <summary>Latest {u.recent.length} requests</summary>
      <table className="usage-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>For</th>
            <th>Result</th>
            <th>Tokens</th>
          </tr>
        </thead>
        <tbody>
          {u.recent.map((r, i) => (
            <tr key={`${r.at}-${i}`}>
              <td>{formatManila(r.at)}</td>
              <td>
                {featureName(r.feature)}
                {r.agent ? ` · ${agentName(r.agent)}` : ''}
                {r.user ? <span className="muted"> · {r.user}</span> : null}
              </td>
              <td>
                <span className={`chip ${r.outcome === 'ok' ? 'status-completed' : r.outcome === 'blocked' ? 'status-awaiting_approval' : 'status-failed'}`}>
                  {r.outcome === 'ok' ? 'OK' : r.outcome === 'blocked' ? 'Blocked' : r.outcome.replace(/_/g, ' ').toLowerCase()}
                </span>
              </td>
              <td>{r.totalTokens === null ? '—' : int(r.totalTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

type Draft = Record<keyof AiLimits, string>;
const FIELDS: { key: keyof AiLimits; label: string; hint: string; step: string }[] = [
  { key: 'dailyRequests', label: 'Requests per day (whole office)', hint: '0 pauses the AI', step: '1' },
  { key: 'userDailyRequests', label: 'Requests per account per day', hint: 'empty = no limit', step: '1' },
  { key: 'dailyTokens', label: 'Tokens per day', hint: 'empty = no limit', step: '1000' },
  { key: 'monthlyBudgetUsd', label: 'Monthly budget (US$)', hint: 'needs both prices', step: '0.01' },
  { key: 'inputUsdPerMillion', label: 'Input price (US$ per 1M tokens)', hint: "from Google's price list", step: '0.001' },
  { key: 'outputUsdPerMillion', label: 'Output price (US$ per 1M tokens)', hint: 'includes thinking', step: '0.001' },
  { key: 'warnPercent', label: 'Warn at (% of a limit)', hint: '50–100', step: '1' },
];
const toDraft = (l: AiLimits): Draft => Object.fromEntries(FIELDS.map((f) => [f.key, l[f.key] === null ? '' : String(l[f.key])])) as Draft;

function LimitsForm({ store, u }: { store: LiveStore; u: AiUsageReport }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(u.limits));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const key = JSON.stringify(u.limits);
  // Show the server's values again after a save or a change made elsewhere.
  useEffect(() => setDraft(toDraft(JSON.parse(key) as AiLimits)), [key]);

  const save = async (reset: boolean) => {
    setError(null);
    setSaved(null);
    let limits: AiLimits | null = null;
    if (!reset) {
      const out: Record<string, number | null> = {};
      for (const f of FIELDS) {
        const raw = draft[f.key].trim();
        if (raw === '' && f.key !== 'warnPercent') out[f.key] = null;
        else {
          const n = Number(raw);
          if (!Number.isFinite(n)) return setError(`${f.label}: enter a number${f.key === 'warnPercent' ? '' : ' or leave it empty'}.`);
          out[f.key] = n;
        }
      }
      limits = out as unknown as AiLimits;
    }
    const err = await store.saveAiLimits(limits);
    if (err) setError(err);
    else setSaved(reset ? 'Back to the server defaults.' : 'Saved. New limits apply to the next request.');
  };

  const d = u.defaults;
  return (
    <details className="usage-form">
      <summary>Change limits and prices{u.customized ? ' (changed in the office)' : ''}</summary>
      <div className="usage-fields">
        {FIELDS.map((f) => (
          <label key={f.key}>
            <span>{f.label}</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step={f.step}
              value={draft[f.key]}
              placeholder={f.key === 'warnPercent' ? '80' : 'no limit'}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
            <small>
              {f.hint} · server default: {d[f.key] === null ? 'none' : String(d[f.key])}
            </small>
          </label>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
      {saved && <p className="muted small">{saved}</p>}
      <div className="row gap-s wrap">
        <button className="btn sm primary" disabled={store.aiUsageSaving} onClick={() => void save(false)}>
          Save limits
        </button>
        <button className="btn sm ghost" disabled={store.aiUsageSaving || !u.customized} onClick={() => void save(true)}>
          Reset to server defaults
        </button>
      </div>
      <p className="muted small">Limits stop a request before it is sent; work already running finishes its current step. Changes are recorded in the task log.</p>
    </details>
  );
}
