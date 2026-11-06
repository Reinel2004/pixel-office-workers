// All business data here is invented for the demo. Prices are placeholders,
// NOT official WAD Furniture pricing, and customers/orders are fictional.

import type { QuoteLine } from '../sim/types';

export const DEMO_PRICE_NOTE = 'DEMO VALUES ONLY — not official WAD Furniture pricing.';

export const SAMPLE_INQUIRY = {
  customer: 'Sample Customer (mock)',
  channel: 'Messenger (simulated — no real account connected)',
  message: 'Hi po! Magkano po ang solid mahogany door, 90 × 210 cm? Para sa main door po namin.',
  size: '90 × 210 cm',
  material: 'Solid mahogany',
};

export const INQUIRY_REQUIREMENTS: { label: string; value: string }[] = [
  { label: 'Door design (plain, carved, or V-cut)', value: 'V-cut panel design' },
  { label: 'Include door jamb?', value: 'Yes — mahogany jamb' },
  { label: 'Finish', value: 'Natural varnish' },
  { label: 'Quantity', value: '1 piece' },
  { label: 'Installation needed?', value: 'Yes' },
  { label: 'Delivery area', value: 'Sample address, Tarlac (mock)' },
  { label: 'Target date', value: 'Within 4 weeks' },
];

export const DEMO_QUOTE_LINES: QuoteLine[] = [
  { item: 'Solid mahogany door slab, V-cut, 90 × 210 cm', qty: 1, unit: 18500 },
  { item: 'Mahogany door jamb set', qty: 1, unit: 6200 },
  { item: 'Hinges, lockset & hardware set', qty: 1, unit: 2800 },
  { item: 'Natural varnish finish', qty: 1, unit: 1500 },
  { item: 'Delivery & installation', qty: 1, unit: 2500 },
];

export interface MockOrder {
  ref: string;
  client: string;
  item: string;
  stage: string;
  dueInDays: number; // relative to "today" when the review runs
  lastUpdateDaysAgo: number;
}

export const MOCK_ORDERS: MockOrder[] = [
  { ref: 'DEMO-101', client: 'Demo Client A', item: 'Flush HPL door ×3', stage: 'Pressing', dueInDays: 5, lastUpdateDaysAgo: 1 },
  { ref: 'DEMO-102', client: 'Demo Client B', item: 'Carved mahogany door', stage: 'Carving', dueInDays: -2, lastUpdateDaysAgo: 1 },
  { ref: 'DEMO-103', client: 'Demo Client C', item: 'V-cut door ×2', stage: 'Assembly', dueInDays: 9, lastUpdateDaysAgo: 6 },
  { ref: 'DEMO-104', client: 'Demo Client D', item: 'Solid mahogany door + jamb', stage: 'Finishing', dueInDays: 3, lastUpdateDaysAgo: 0 },
  { ref: 'DEMO-105', client: 'Demo Client E', item: 'Flush door ×6', stage: 'Cutting', dueInDays: 12, lastUpdateDaysAgo: 2 },
];

export const STALE_UPDATE_DAYS = 5;

export function reviewOrder(o: MockOrder): { level: 'ok' | 'warn'; issue: string } {
  if (o.dueInDays < 0) return { level: 'warn', issue: `Overdue by ${-o.dueInDays} days (stage: ${o.stage})` };
  if (o.lastUpdateDaysAgo >= STALE_UPDATE_DAYS)
    return { level: 'warn', issue: `No progress update in ${o.lastUpdateDaysAgo} days (stage: ${o.stage})` };
  return { level: 'ok', issue: `On track — ${o.stage}, due in ${o.dueInDays} days` };
}

export const MARKETING_JOB = {
  item: 'Solid mahogany main door with V-cut panels',
  finish: 'natural varnish',
  location: 'a home in Tarlac (sample)',
};

export const peso = (n: number) => '₱' + n.toLocaleString('en-PH');
