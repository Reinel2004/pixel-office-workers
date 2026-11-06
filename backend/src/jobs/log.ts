// Append-only task log (JSON lines). Entries hold ids, report type, user, status, timings and
// error codes — never amounts, customer details, tokens or request headers.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const SECRET_KEYS = /pass|secret|token|key|auth|cookie|credential/i;

export function redact(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : v;
  return out;
}

export function createTaskLog(file: string | null) {
  let ready: Promise<unknown> | null = null;
  return (entry: Record<string, unknown>) => {
    const line = JSON.stringify(redact(entry)) + '\n';
    if (!file) {
      // No log file (e.g. on Render, whose disk is wiped on restart): print it, so it shows in the host's logs.
      process.stdout.write(`[task] ${line}`);
      return;
    }
    ready ??= mkdir(dirname(file), { recursive: true });
    ready.then(() => appendFile(file, line)).catch(() => undefined);
  };
}
