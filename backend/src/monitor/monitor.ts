// What Sam (Systems Monitor) and Ivy (Security Officer) read: measurements the server takes of
// itself, kept in memory for at most 7 days and never written to disk.
//
// HealthLog: every outgoing call to the order system, the finance system, Gemini and Facebook,
//   with only its time, duration and HTTP status (no URLs, query strings, bodies or tokens).
// SecurityLog: sign-ins and refused requests. Client addresses are stored only as a salted
//   fingerprint used to count distinct sources; usernames only when they are real accounts.

import { createHash, randomBytes } from 'node:crypto';

export type HealthSystem = 'orders' | 'finance' | 'gemini' | 'facebook' | 'github';
type Status = number | 'TIMEOUT' | 'NETWORK';
interface Sample {
  at: number;
  ok: boolean;
  ms: number;
  status: Status;
}

const DAY = 86_400_000;
const MAX_SAMPLES = 3000;

export class HealthLog {
  private samples = new Map<HealthSystem, Sample[]>();
  constructor(private now: () => number = Date.now) {}

  record(system: HealthSystem, s: Omit<Sample, 'at'>) {
    const list = this.samples.get(system) ?? [];
    list.push({ at: this.now(), ...s });
    const cutoff = this.now() - DAY;
    while (list.length && (list[0].at < cutoff || list.length > MAX_SAMPLES)) list.shift();
    this.samples.set(system, list);
  }

  /** Wraps fetch so each call's duration and status are recorded (nothing else about it). */
  instrument(system: HealthSystem, base: typeof fetch = fetch): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const t0 = this.now();
      try {
        const res = await base(input, init);
        // 3xx is a redirect the clients refuse (approved hosts only), so it counts as a failure.
        this.record(system, { ok: res.status < 300, ms: this.now() - t0, status: res.status });
        return res;
      } catch (e) {
        const name = (e as Error)?.name;
        this.record(system, { ok: false, ms: this.now() - t0, status: name === 'AbortError' || name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK' });
        throw e;
      }
    }) as typeof fetch;
  }

  summary(system: HealthSystem) {
    const cutoff = this.now() - DAY;
    const list = (this.samples.get(system) ?? []).filter((s) => s.at >= cutoff);
    const fails = list.filter((s) => !s.ok);
    let inARow = 0;
    for (let i = list.length - 1; i >= 0 && !list[i].ok; i--) inARow++;
    const lastOk = [...list].reverse().find((s) => s.ok);
    const lastFail = fails[fails.length - 1];
    const ms = list.map((s) => s.ms);
    const byStatus: Record<string, number> = {};
    for (const f of fails) byStatus[String(f.status)] = (byStatus[String(f.status)] ?? 0) + 1;
    return {
      requestsLast24h: list.length,
      failuresLast24h: fails.length,
      failuresInARowNow: inARow,
      failuresByStatus: byStatus,
      averageMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
      slowestMs: ms.length ? Math.max(...ms) : null,
      lastOkAt: lastOk ? new Date(lastOk.at).toISOString() : null,
      lastFailure: lastFail ? { at: new Date(lastFail.at).toISOString(), status: lastFail.status } : null,
    };
  }
}

export type SecurityEvent =
  | 'login_ok'
  | 'login_failed'
  | 'login_throttled'
  | 'csrf_blocked'
  | 'permission_denied'
  | 'rate_limited'
  | 'not_signed_in';

interface SecEntry {
  at: number;
  type: SecurityEvent;
  /** A real account name (never what someone typed for an unknown account). */
  user: string | null;
  unknownUser: boolean;
  source: string;
  area: string;
}

const MAX_EVENTS = 5000;

export class SecurityLog {
  private events: SecEntry[] = [];
  private salt = randomBytes(16);
  constructor(private now: () => number = Date.now) {}

  /** `source` is the client address; only a salted fingerprint of it is kept. */
  record(type: SecurityEvent, o: { user?: string | null; unknownUser?: boolean; source: string; path?: string }) {
    const source = createHash('sha256').update(this.salt).update(o.source).digest('hex').slice(0, 12);
    // "/api/facebook/posts" -> "facebook": an area name, never ids or query strings.
    const area = (o.path ?? '').split('/')[2]?.replace(/[^a-z-]/gi, '').slice(0, 20) || 'other';
    this.events.push({ at: this.now(), type, user: o.user ?? null, unknownUser: !!o.unknownUser, source, area });
    const cutoff = this.now() - 7 * DAY;
    while (this.events.length && (this.events[0].at < cutoff || this.events.length > MAX_EVENTS)) this.events.shift();
  }

  summary(hours: number) {
    const h = Math.min(168, Math.max(1, Math.round(hours)));
    const since = this.now() - h * 3_600_000;
    const ev = this.events.filter((e) => e.at >= since);
    const count = (t: SecurityEvent) => ev.filter((e) => e.type === t).length;
    const failed = ev.filter((e) => e.type === 'login_failed');
    const byAccount: Record<string, number> = {};
    for (const f of failed) if (f.user) byAccount[f.user] = (byAccount[f.user] ?? 0) + 1;
    const denied: Record<string, number> = {};
    for (const e of ev.filter((x) => x.type === 'permission_denied')) denied[e.area] = (denied[e.area] ?? 0) + 1;
    // The source with the most failed sign-ins (by fingerprint), to spot one machine guessing.
    const perSource = new Map<string, number>();
    for (const f of failed) perSource.set(f.source, (perSource.get(f.source) ?? 0) + 1);
    const lastOk: Record<string, string> = {};
    for (const e of ev) if (e.type === 'login_ok' && e.user) lastOk[e.user] = new Date(e.at).toISOString();
    return {
      hours: h,
      recordedSince: this.events.length ? new Date(this.events[0].at).toISOString() : null,
      signIns: {
        ok: count('login_ok'),
        failed: failed.length,
        throttled: count('login_throttled'),
        failedByAccount: byAccount,
        failedForUnknownUsernames: failed.filter((f) => f.unknownUser).length,
        distinctSourcesWithFailures: perSource.size,
        mostFailuresFromOneSource: perSource.size ? Math.max(...perSource.values()) : 0,
        lastSuccessfulSignInByAccount: lastOk,
      },
      crossSiteRequestsBlocked: count('csrf_blocked'),
      permissionDeniedByArea: denied,
      rateLimited: count('rate_limited'),
      requestsWithoutSignIn: count('not_signed_in'),
    };
  }
}
