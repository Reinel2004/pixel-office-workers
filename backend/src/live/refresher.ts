// Live updates: re-reads a few things on a fixed timer and pushes changes to the open offices.
//
// Bounded on purpose (the owner asked for no request loops):
//  - It runs only while at least one browser has the office open, and stops when the last closes.
//  - Each check is one request per source, shared by every viewer (never one per browser).
//  - Checks never overlap, and a failing source waits longer each time (up to maxBackoffMs).
//  - Nothing is pushed unless the data actually changed.

export interface RefreshSource<T> {
  name: string;
  /** Reads the current value; null = this source is switched off (e.g. Facebook not set up). */
  read: () => Promise<T | null>;
  /** Parts of the value that change on every read (e.g. "asOf") and must not count as a change. */
  fingerprint?: (v: T) => unknown;
}

interface State {
  source: RefreshSource<unknown>;
  last: unknown;
  lastKey: string | null;
  failures: number;
  nextAt: number;
  running: boolean;
}

export class LiveRefresher {
  private states: State[];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    sources: RefreshSource<unknown>[],
    private opts: {
      intervalMs: number;
      maxBackoffMs: number;
      /** Whether anyone is watching (open browser streams). */
      hasListeners: () => boolean;
      /** Called with the new value when a source changed. */
      onChange: (name: string, value: unknown) => void;
      log?: (line: string) => void;
      now?: () => number;
    },
  ) {
    this.states = sources.map((source) => ({ source, last: null, lastKey: null, failures: 0, nextAt: 0, running: false }));
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /** The last value read for a source (sent to a browser when it connects). */
  latest(name: string): unknown {
    return this.states.find((s) => s.source.name === name)?.last ?? null;
  }

  /** Starts the timer if it is not running (called when a browser connects). */
  ensureRunning() {
    if (this.timer || this.opts.intervalMs <= 0) return;
    this.schedule(0);
  }

  /** Re-reads one source soon, e.g. right after someone posts to Facebook (still never overlapping). */
  poke(name: string) {
    const s = this.states.find((x) => x.source.name === name);
    if (!s || this.opts.intervalMs <= 0) return;
    s.nextAt = Math.min(s.nextAt, this.now() + 1500);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(1500);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  /** Runs every source that is due, then sleeps until the next one is due. Exported for tests. */
  async tick() {
    this.timer = null;
    if (!this.opts.hasListeners()) return; // nobody watching: stop until someone connects
    const now = this.now();
    await Promise.all(this.states.filter((s) => !s.running && s.nextAt <= now).map((s) => this.run(s)));
    if (!this.opts.hasListeners()) return;
    const next = Math.min(...this.states.map((s) => s.nextAt));
    this.schedule(Math.max(1000, next - this.now()));
  }

  private async run(s: State) {
    s.running = true;
    try {
      const v = await s.source.read();
      s.failures = 0;
      const key = v === null ? 'null' : JSON.stringify(s.source.fingerprint ? s.source.fingerprint(v) : v);
      if (key !== s.lastKey) {
        const first = s.lastKey === null;
        s.lastKey = key;
        s.last = v;
        if (!first || v !== null) this.opts.onChange(s.source.name, v);
      } else s.last = v;
    } catch (e) {
      s.failures++;
      this.opts.log?.(`[live] ${s.source.name} check failed (${s.failures} in a row): ${(e as Error).message}`);
    } finally {
      s.running = false;
      const wait = Math.min(this.opts.maxBackoffMs, this.opts.intervalMs * 2 ** s.failures);
      s.nextAt = this.now() + wait;
    }
  }
}
