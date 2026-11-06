// Reporting dates use Asia/Manila. The Philippines has no daylight saving (UTC+08:00),
// but we still go through Intl so the code stays correct if run on a server in any zone.

import type { DateRange } from './live';

export const REPORT_TZ = 'Asia/Manila';
export const MANILA_OFFSET = '+08:00';

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD for the given instant in Manila. */
export function manilaDate(at: Date = new Date()): string {
  return fmt.format(at);
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Start (inclusive) and end (exclusive) instants of a Manila date range, as ISO strings with offset. */
export function rangeBounds(r: DateRange): { start: string; endExclusive: string } {
  return { start: `${r.from}T00:00:00${MANILA_OFFSET}`, endExclusive: `${addDays(r.to, 1)}T00:00:00${MANILA_OFFSET}` };
}

export type RangePreset = 'today' | 'last7' | 'thisMonth' | 'lastMonth' | 'thisYear';

export function presetRange(p: RangePreset, today = manilaDate()): DateRange {
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'last7':
      return { from: addDays(today, -6), to: today };
    case 'thisMonth':
      return { from: `${y}-${pad(m)}-01`, to: today };
    case 'lastMonth': {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      const first = `${ly}-${pad(lm)}-01`;
      return { from: first, to: addDays(`${y}-${pad(m)}-01`, -1) };
    }
    case 'thisYear':
      return { from: `${y}-01-01`, to: today };
  }
}

export function validateRange(r: Partial<DateRange>, maxDays: number): string | null {
  if (!isIsoDate(r.from) || !isIsoDate(r.to)) return 'Dates must be in YYYY-MM-DD format.';
  if (r.from > r.to) return 'The start date must be on or before the end date.';
  if (daysBetween(r.from, r.to) + 1 > maxDays) return `The date range can be at most ${maxDays} days.`;
  return null;
}

/** "Nov 5, 2026, 2:36 PM" in Manila time. */
export function formatManila(iso: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: REPORT_TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}
