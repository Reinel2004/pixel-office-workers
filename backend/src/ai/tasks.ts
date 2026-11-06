// Free-text tasks for the office agents, answered by the AI provider.
//
// How a task runs:
//  1. The agent's role, today's date (Manila), the business notes in knowledge/ and the request
//     are sent to the AI, together with the read-only data tools this agent AND this user may use.
//  2. When the AI asks for data, the server fetches it through the same adapters the reports use
//     and returns totals and counts calculated BY CODE, so the AI never adds up figures itself.
//  3. The AI's final text is returned with a list of every lookup it made and its sources.
//
// The AI cannot change anything: every tool is a read-only GET to an approved base URL.
//
// Request limits (no loops): a task makes at most maxToolRounds + 1 Gemini requests. The last
// one is sent with function calling turned off, so the AI must answer with what it has. Each
// task allows at most MAX_TOOL_CALLS lookups in total, and repeating an identical lookup reuses
// the first result instead of calling the business system again.
// Customer names: the adapters carry them for DISPLAY, but every tool response below is built
// from explicit fields that leave the name out, so the AI only ever sees order numbers. The names
// go back to the browser in `customers` (order number -> name), which the office shows next to
// each order number in the AI's answer.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DateRange, LiveAgentId, Money, Permission, SessionUser, SourceInfo, SystemId } from '../../shared/live';
import { SYSTEM_NAMES } from '../../shared/live';
import { manilaDate, validateRange } from '../../shared/manila';
import type { FinanceSource, OrderRecord, OrderSource } from '../adapters/types';
import { IntegrationError } from '../http/errors';
import {
  collections,
  customerNames,
  financeSummary,
  financeTrends,
  orderStatus,
  orderTrends,
  overdueOrders,
  productionPipeline,
  productMix,
} from '../reports/calc';
import type { FunctionDeclaration, GeminiClient, GeminiContent, GeminiPart } from './gemini';

type ToolName =
  | 'get_orders'
  | 'get_open_orders'
  | 'get_finance'
  | 'get_collections'
  | 'get_order_trends'
  | 'get_product_mix'
  | 'get_production_pipeline'
  | 'get_finance_trends';

interface AgentProfile {
  name: string;
  role: string;
  focus: string;
  tools: ToolName[];
}

export const AGENT_PROFILES: Record<LiveAgentId, AgentProfile> = {
  lia: {
    name: 'Lia',
    role: 'Sales Assistant',
    focus: 'Handles customer inquiries and gathers requirements (door size, design, wood, finish). Drafts friendly replies in English or Taglish as asked.',
    tools: ['get_orders', 'get_open_orders'],
  },
  marco: {
    name: 'Marco',
    role: 'Quotation Assistant',
    focus: 'Prepares quotation drafts for review. Uses prices only from the business notes; if a price is not in the notes, leaves a clear placeholder instead of guessing.',
    tools: [],
  },
  paolo: {
    name: 'Paolo',
    role: 'Production Tracker',
    focus: 'Tracks shop-floor progress, order statuses, stages (production, roughing, assembling, finishing, done) and due dates.',
    tools: ['get_orders', 'get_open_orders'],
  },
  nina: {
    name: 'Nina',
    role: 'Installation Scheduler',
    focus: 'Plans installation and delivery dates from open orders and their due dates.',
    tools: ['get_open_orders', 'get_orders'],
  },
  bea: {
    name: 'Bea',
    role: 'Finance Reporter',
    focus: 'Reports recorded income, operating expenses by category, and monthly budgets.',
    tools: ['get_finance', 'get_collections'],
  },
  mika: {
    name: 'Mika',
    role: 'Data Analyst',
    focus:
      'Works in the Intelligence Lab. Finds trends over time: whether orders are going up or down, what customers order most (category, door type, wood, finish), where production gets stuck, and which months were best for income and expenses. Explains what the numbers mean and suggests one or two practical next steps, but never invents a cause the data does not show. Says when a period is too short to call it a trend.',
    tools: ['get_order_trends', 'get_product_mix', 'get_production_pipeline', 'get_finance_trends', 'get_orders'],
  },
  rosa: {
    name: 'Rosa',
    role: 'Collections Officer',
    focus:
      'Follows up remaining balances and downpayments on open orders, so finished orders are paid before or at delivery. Prioritises Finished orders with a balance, then overdue ones, then the largest balances. Drafts polite, firm payment reminders in English or Taglish for a staff member to send; customer names are not available to you, so write [Customer name] as a placeholder.',
    tools: ['get_collections', 'get_open_orders'],
  },
  carlo: {
    name: 'Carlo',
    role: 'Marketing Writer',
    focus:
      'Writes captions and posts for finished projects (doors and furniture). Never invents customer names, prices or promises. When given a photo, looks carefully at it first and writes the caption from what is actually visible.',
    tools: [],
  },
  dev: {
    name: 'Dev',
    role: 'Software Assistant',
    focus: 'Helps with the office tools and the order system: explains data, spots inconsistencies (missing due dates, odd statuses).',
    tools: ['get_orders', 'get_open_orders'],
  },
  chief: {
    name: 'Chief',
    role: 'Coordinator',
    focus: 'Coordinates the team, sets priorities, and combines production and finance information.',
    tools: ['get_open_orders', 'get_orders', 'get_finance', 'get_collections'],
  },
};

/** Every listed permission is required. Balances are money, so collections also needs finance access. */
const TOOL_PERMISSIONS: Record<ToolName, Permission[]> = {
  get_orders: ['orders:read'],
  get_open_orders: ['orders:read'],
  get_finance: ['finance:read'],
  get_collections: ['orders:read', 'finance:read'],
  // Order values inside these are shown only to users who also have finance:read.
  get_order_trends: ['orders:read'],
  get_product_mix: ['orders:read'],
  get_production_pipeline: ['orders:read'],
  get_finance_trends: ['finance:read'],
};

const RANGE_PARAMS = {
  type: 'object' as const,
  properties: {
    from: { type: 'string', description: 'Start date, YYYY-MM-DD (inclusive, Asia/Manila)' },
    to: { type: 'string', description: 'End date, YYYY-MM-DD (inclusive, Asia/Manila)' },
  },
  required: ['from', 'to'],
};

const DECLARATIONS: Record<ToolName, FunctionDeclaration> = {
  get_orders: {
    name: 'get_orders',
    description:
      'Orders created (order date) within a date range, from WAD Order Management. Returns counts by status, open and overdue counts, and each order: reference, status, due date, days overdue, progress percent and least-advanced stage.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD (inclusive, Asia/Manila)' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD (inclusive, Asia/Manila)' },
      },
      required: ['from', 'to'],
    },
  },
  get_open_orders: {
    name: 'get_open_orders',
    description:
      'Every order that is not yet Delivered, whatever its date, from WAD Order Management. Includes which are overdue as of today and by how many days, due dates, progress and stage.',
  },
  get_finance: {
    name: 'get_finance',
    description:
      'Finance for a date range from WAD Furniture Management: recorded income, operating expenses and net (totals calculated by code), expenses by category, monthly budgets, and the individual records. Payroll and material purchases are NOT included.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD (inclusive, Asia/Manila)' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD (inclusive, Asia/Manila)' },
      },
      required: ['from', 'to'],
    },
  },
  get_order_trends: {
    name: 'get_order_trends',
    description:
      'Orders over time by order date, calculated by code: per month or week, the number of orders, pieces, how many are delivered or still open, and (if the user may see money) order value and average order value. Also the busiest period and a first-half vs second-half comparison. Use a range of several months for trends.',
    parameters: {
      type: 'object',
      properties: {
        ...RANGE_PARAMS.properties,
        period: { type: 'string', description: 'Group by "month" (default) or "week"' },
      },
      required: ['from', 'to'],
    },
  },
  get_product_mix: {
    name: 'get_product_mix',
    description:
      'What customers ordered in a date range, calculated by code: pieces and share by product category, door type, wood, finish, and the top combinations (e.g. Door · Carved · Narra · With Varnish). Includes value per group if the user may see money.',
    parameters: RANGE_PARAMS,
  },
  get_production_pipeline: {
    name: 'get_production_pipeline',
    description:
      'Where all open (not Delivered) orders are right now, by least-advanced production stage: how many, how many overdue, average days since ordered, average days since the order last moved stage, the orders waiting longest, and the slowest stage. Use it for bottleneck questions.',
  },
  get_finance_trends: {
    name: 'get_finance_trends',
    description:
      'Income, operating expenses and net per month from WAD Furniture Management, calculated by code, with each month\'s largest expense category, and the best and worst months by net. Payroll and material purchases are not included.',
    parameters: RANGE_PARAMS,
  },
  get_collections: {
    name: 'get_collections',
    description:
      'Remaining balances on every open (not Delivered) order, from WAD Order Management, calculated by code: balance = order price - downpayment. Returns total balance, total downpayments, the balance on Finished orders waiting for delivery, orders with no downpayment, and each order with a balance (reference, status, due date, days overdue, price, downpayment, balance). Delivered orders count as fully paid.',
  },
};

export function toolsFor(agent: LiveAgentId, user: SessionUser): ToolName[] {
  return AGENT_PROFILES[agent].tools.filter((t) => TOOL_PERMISSIONS[t].every((p) => user.permissions.includes(p)));
}

export interface AiTaskDeps {
  ai: GeminiClient;
  finance: FinanceSource;
  orders: OrderSource;
  maxToolRounds: number;
  maxRangeDays: number;
  knowledgeDir: string;
  now?: () => Date;
}

export interface AiTaskOutcome {
  answer: string;
  model: string;
  lookups: { tool: string; detail: string; ok: boolean }[];
  sources: SourceInfo[];
  references: string[];
  recordCount: number;
  /** Order number -> customer name, for the browser only. */
  customers: Record<string, string>;
}

/** Added to the instructions when a photo comes with the task. */
const PHOTO_RULES = `

A photo is attached to this request.
- First, under "**What I see**", list in 3 to 6 short bullets only what is visible: the product (door, cabinet, table…), design (panels, carving, V-cut, glass, louvers), colour and finish (natural, varnished, stained, painted, gloss or matte), hardware, and the setting.
- Wood species cannot be confirmed from a photo: write "looks like narra" or similar, unless the request or the business notes name the wood.
- If the photo is not furniture, is too dark or blurry, or you are unsure, say so plainly instead of guessing.
- Then write the post: "**Caption**" (2 to 4 sentences, warm and proud, ends with a call to message WAD for a quotation), "**Short version**" (one line), and "**Hashtags**" (5 to 8, including #WADFurniture).
- Do not mention people, faces, house numbers, addresses or plate numbers that appear in the photo. Never invent a customer name, price or delivery promise.`;

const MAX_RECORDS_TO_AI = 150;
/** Most data lookups one task may make, across all rounds (identical repeats are free). */
export const MAX_TOOL_CALLS = 6;
const MAX_ANSWER_CHARS = 8000;
const MAX_KNOWLEDGE_CHARS = 24000;

export async function runAiTask(
  deps: AiTaskDeps,
  user: SessionUser,
  agent: LiveAgentId,
  prompt: string,
  image?: { mimeType: string; data: string },
): Promise<AiTaskOutcome> {
  const today = manilaDate(deps.now?.());
  const tools = toolsFor(agent, user);
  const profile = AGENT_PROFILES[agent];
  const lookups: AiTaskOutcome['lookups'] = [];
  const sources: SourceInfo[] = [];
  const refs = new Set<string>();
  const customers: Record<string, string> = {};
  const names = (orders: OrderRecord[]) => Object.assign(customers, customerNames(orders, undefined, 500 - Object.keys(customers).length));
  let recordCount = 0;

  // A photo goes in the same first message as the request, before the text.
  const contents: GeminiContent[] = [{ role: 'user', parts: [...(image ? [{ inlineData: image }] : []), { text: prompt }] }];
  const cache = new Map<string, Record<string, unknown>>();
  let toolCalls = 0;
  const request = (allowTools: boolean) => ({
    systemInstruction: {
      parts: [{ text: systemPrompt(profile, today, tools, profile.tools.filter((t) => !tools.includes(t)), user, loadKnowledge(deps.knowledgeDir)) + (image ? PHOTO_RULES : '') }],
    },
    contents,
    ...(tools.length ? { tools: [{ functionDeclarations: tools.map((t) => DECLARATIONS[t]) }] } : {}),
    generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
    ...(tools.length && !allowTools ? { toolConfig: { functionCallingConfig: { mode: 'NONE' as const } } } : {}),
  });

  const source = (system: SystemId, count: number) => {
    const status = system === 'finance' ? deps.finance.status() : deps.orders.status();
    sources.push({ system, systemName: SYSTEM_NAMES[system], host: status.host ?? '', retrievedAt: new Date().toISOString(), recordCount: count });
    recordCount += count;
  };

  // Bounded: rounds 0..maxToolRounds, and the last round cannot ask for data.
  for (let round = 0; round <= deps.maxToolRounds; round++) {
    const last = round === deps.maxToolRounds || toolCalls >= MAX_TOOL_CALLS;
    const { content, finishReason } = await deps.ai.generate(request(!last));
    const calls = content.parts.filter((p): p is Extract<GeminiPart, { functionCall: unknown }> => 'functionCall' in p);
    if (!calls.length) {
      const answer = content.parts
        .filter((p): p is Extract<GeminiPart, { text: string }> => 'text' in p && !p.thought)
        .map((p) => p.text)
        .join('')
        .trim();
      if (!answer)
        throw new IntegrationError('INVALID_RESPONSE', finishReason === 'MAX_TOKENS' ? 'Gemini ran out of space before answering. Try a shorter or more specific request.' : 'Gemini returned an empty answer.');
      return { answer: answer.slice(0, MAX_ANSWER_CHARS), model: deps.ai.model, lookups, sources, references: [...refs].slice(0, 50), recordCount, customers };
    }
    if (last) break; // asked for data although it was told to answer: stop, never loop

    contents.push(content); // returned unchanged, so thought signatures stay intact
    const responses: GeminiPart[] = [];
    for (const { functionCall } of calls) {
      const name = functionCall.name as ToolName;
      const args = functionCall.args ?? {};
      let response: Record<string, unknown>;
      const key = `${name}|${String(args.from ?? '')}|${String(args.to ?? '')}|${String(args.period ?? '')}`;
      if (!tools.includes(name)) {
        response = { error: `Tool "${functionCall.name}" is not available to ${profile.name} for this user.` };
        lookups.push({ tool: String(functionCall.name), detail: 'not allowed', ok: false });
      } else if (cache.has(key)) {
        response = { ...cache.get(key)!, note: 'Same data as your earlier lookup; nothing new was fetched.' };
      } else if (toolCalls >= MAX_TOOL_CALLS) {
        response = { error: `The limit of ${MAX_TOOL_CALLS} data lookups for one task was reached. Answer with the data you already have.` };
        lookups.push({ tool: name, detail: `${describe(name, args)} — skipped (lookup limit reached)`, ok: false });
      } else {
        toolCalls++;
        try {
          response = await callTool(name, args, deps, today, { source, refs, names, money: user.permissions.includes('finance:read') });
          cache.set(key, response);
          lookups.push({ tool: name, detail: describe(name, args), ok: true });
        } catch (e) {
          // A data failure is passed to the AI as a fact, so it says so instead of guessing.
          const msg = e instanceof IntegrationError ? e.message : 'The data could not be retrieved.';
          response = { error: msg, note: 'No data was returned. Tell the user this data is unavailable; do not estimate it.' };
          lookups.push({ tool: name, detail: `${describe(name, args)} — failed: ${msg}`, ok: false });
        }
      }
      responses.push({ functionResponse: { name: functionCall.name, response, ...(functionCall.id ? { id: functionCall.id } : {}) } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  throw new IntegrationError('INVALID_RESPONSE', 'The AI kept asking for more data instead of answering. Try a more specific request.');
}

function describe(name: ToolName, args: Record<string, unknown>) {
  if (name === 'get_open_orders') return 'all open orders';
  if (name === 'get_collections') return 'balances on open orders';
  if (name === 'get_production_pipeline') return 'all open orders by stage';
  if (name === 'get_order_trends') return `${String(args.from ?? '?')} to ${String(args.to ?? '?')}, by ${args.period === 'week' ? 'week' : 'month'}`;
  return `${String(args.from ?? '?')} to ${String(args.to ?? '?')}`;
}

function rangeArg(args: Record<string, unknown>, maxDays: number): DateRange {
  const r = { from: args.from, to: args.to } as Partial<DateRange>;
  const problem = validateRange(r, maxDays);
  if (problem) throw new IntegrationError('INVALID_RESPONSE', `Invalid date range from the AI: ${problem}`);
  return r as DateRange;
}

function pesos(list: Money[]) {
  return list.map((m) => ({ currency: m.currency, amount: (m.centavos / 100).toFixed(2) }));
}

async function callTool(
  name: ToolName,
  args: Record<string, unknown>,
  deps: AiTaskDeps,
  today: string,
  track: { source: (s: SystemId, n: number) => void; refs: Set<string>; names: (o: OrderRecord[]) => void; money: boolean },
): Promise<Record<string, unknown>> {
  if (name === 'get_finance') {
    const range = rangeArg(args, deps.maxRangeDays);
    const [income, expenses] = await Promise.all([deps.finance.listIncome(range), deps.finance.listExpenses(range)]);
    const budgets = deps.finance.capabilities.budgets ? await deps.finance.listBudgets(range) : null;
    const { report, notes } = financeSummary(range, income, expenses, budgets, deps.finance.capabilities.budgetsByCategory);
    const records = [...income, ...expenses];
    track.source('finance', records.length + (budgets?.length ?? 0));
    records.slice(0, 50).forEach((r) => track.refs.add(r.ref));
    return {
      range,
      calculatedByCode: true,
      totals: { income: pesos(report.income), operatingExpenses: pesos(report.expenses), net: pesos(report.net) },
      expensesByCategory: report.expensesByCategory.map((c) => ({ category: c.category, amounts: pesos(c.amounts) })),
      monthlyBudgets: report.budgets.map((b) => ({ month: b.ref.replace('BUDGET-', ''), amounts: pesos(b.amounts) })),
      incomeRecordCount: income.length,
      expenseRecordCount: expenses.length,
      records: records.slice(0, MAX_RECORDS_TO_AI).map((r) => ({ ref: r.ref, kind: r.kind, date: r.date, amount: (r.centavos / 100).toFixed(2), currency: r.currency, category: r.category })),
      recordsTruncated: records.length > MAX_RECORDS_TO_AI,
      notes: [...notes, 'Income is every recorded income entry (Received, Pending and Partial). Payroll and material purchases are not included in expenses.'],
    };
  }
  if (name === 'get_orders') {
    const range = rangeArg(args, deps.maxRangeDays);
    const orders = await deps.orders.listOrders(range);
    track.names(orders);
    const { report, notes } = orderStatus(range, orders, today, deps.orders.capabilities.closedStatuses);
    track.source('orders', orders.length);
    orders.slice(0, 50).forEach((o) => track.refs.add(o.ref));
    return {
      range,
      today,
      calculatedByCode: true,
      orderCount: orders.length,
      byStatus: report.byStatus,
      open: report.open,
      overdue: report.overdue,
      orders: report.rows.slice(0, MAX_RECORDS_TO_AI).map((r, i) => ({ ...r, orderDate: orders[i]?.createdDate ?? null })),
      ordersTruncated: report.rows.length > MAX_RECORDS_TO_AI,
      notes: [...notes, 'Only "Delivered" closes an order. A "Finished" order past its due date is still overdue.'],
    };
  }
  if (name === 'get_order_trends') {
    const range = rangeArg(args, deps.maxRangeDays);
    const orders = await deps.orders.listOrders(range, { products: true });
    track.source('orders', orders.length);
    track.names(orders);
    const period = args.period === 'week' ? 'week' : 'month';
    return {
      ...orderTrends(range, orders, period, track.money && deps.orders.capabilities.payments === true),
      calculatedByCode: true,
      notes: [
        'Grouped by the date each order was placed. "stillOpen" means not yet Delivered.',
        ...(track.money ? [] : ['Order values are hidden: this user has no finance permission.']),
        ...(deps.orders.capabilities.products ? [] : ['Piece counts are unavailable (the order system did not return product details).']),
      ],
    };
  }
  if (name === 'get_product_mix') {
    const range = rangeArg(args, deps.maxRangeDays);
    const orders = await deps.orders.listOrders(range, { products: true });
    track.source('orders', orders.length);
    track.names(orders);
    if (deps.orders.capabilities.products !== true)
      return { error: 'WAD Order Management did not return product details.', note: 'Product mix is unavailable. Do not estimate it.' };
    return {
      range,
      ...productMix(orders, track.money && deps.orders.capabilities.payments === true),
      calculatedByCode: true,
      notes: ['Counts are pieces (one row per piece in the order system). sharePercent is of all pieces in the range.'],
    };
  }
  if (name === 'get_production_pipeline') {
    const open = await deps.orders.listOpenOrders();
    track.source('orders', open.length);
    track.names(open);
    const p = productionPipeline(open, today, deps.orders.capabilities.stageDates === true);
    p.stages.forEach((s) => s.longestWaiting.forEach((w) => track.refs.add(w.ref)));
    return {
      ...p,
      calculatedByCode: true,
      notes: [
        'Each order is counted at the stage of its least-advanced piece. "unknown" = no recognised stage.',
        p.stageDatesAvailable
          ? '"Days since last progress" counts from the last time any piece of the order moved stage.'
          : 'Stage-change dates are not available, so waiting time is measured from the order date.',
      ],
    };
  }
  if (name === 'get_finance_trends') {
    const range = rangeArg(args, deps.maxRangeDays);
    const [income, expenses] = await Promise.all([deps.finance.listIncome(range), deps.finance.listExpenses(range)]);
    track.source('finance', income.length + expenses.length);
    return {
      ...financeTrends(range, income, expenses),
      calculatedByCode: true,
      notes: ['Income is every recorded income entry. Payroll and material purchases are not included in expenses.'],
    };
  }
  if (name === 'get_collections') {
    const open = await deps.orders.listOpenOrders();
    track.source('orders', open.length);
    track.names(open);
    if (deps.orders.capabilities.payments !== true)
      return { error: 'WAD Order Management did not provide order prices and downpayments.', note: 'Balances are unavailable. Do not estimate them.' };
    const c = collections(open, today);
    c.rows.slice(0, 50).forEach((r) => track.refs.add(r.ref));
    return {
      ...c,
      calculatedByCode: true,
      currency: 'PHP',
      rows: c.rows.slice(0, MAX_RECORDS_TO_AI),
      rowsTruncated: c.rows.length > MAX_RECORDS_TO_AI,
      missingAmounts: c.missingAmounts.slice(0, 50),
      notes: [
        'balance = order price - downpayment, the same rule the order system uses. Delivered orders count as fully paid and are not listed.',
        'Payments other than the downpayment are not recorded separately in the order system, so a balance may already be partly settled. Say so when it matters.',
      ],
    };
  }
  const open = await deps.orders.listOpenOrders();
  track.names(open);
  const { report, notes } = overdueOrders(open, today);
  const overdueRefs = new Set(report.overdue.map((o) => o.ref));
  track.source('orders', open.length);
  open.slice(0, 50).forEach((o) => track.refs.add(o.ref));
  return {
    today,
    calculatedByCode: true,
    openCount: open.length,
    overdueCount: report.overdue.length,
    overdue: report.overdue.slice(0, MAX_RECORDS_TO_AI),
    otherOpenOrders: open
      .filter((o) => !overdueRefs.has(o.ref))
      .slice(0, MAX_RECORDS_TO_AI)
      .map((o) => ({ ref: o.ref, status: o.status, dueDate: o.dueDate, progressPercent: o.progressPercent, stage: o.stage, orderDate: o.createdDate })),
    undetermined: report.undetermined,
    notes: [...notes, 'Only "Delivered" closes an order. A "Finished" order past its due date is still overdue.'],
  };
}

function systemPrompt(p: AgentProfile, today: string, tools: ToolName[], missing: ToolName[], user: SessionUser, knowledge: string): string {
  return [
    `You are ${p.name}, the ${p.role} at WAD Furniture Philippines, a maker of wooden doors and furniture. ${p.focus}`,
    `Today is ${today} (Asia/Manila). Amounts are in Philippine pesos (₱). You are answering ${user.username}, a staff member.`,
    tools.length
      ? `You can look up live company data with these read-only tools: ${tools.join(', ')}. Use them for ANY question about orders, production, deadlines, income, expenses or budgets — never answer those from memory.`
      : 'You have no access to live company data. If the request needs live order or finance figures, say which colleague can get them (Paolo for orders and production, Bea for finance, Rosa for unpaid balances, Mika for trends and best sellers, Chief for all of these).',
    missing.length ? `This user's account cannot use: ${missing.join(', ')}. If the request needs that data, say so plainly.` : '',
    'Rules:',
    '- Use only figures that the tools returned or that appear in the business notes. Never invent, estimate or round off numbers, order references, dates, names or prices.',
    '- Totals marked calculatedByCode are exact: quote them as given and do not re-add records yourself.',
    '- If data is missing, empty, failed to load, or truncated, say so clearly.',
    '- You cannot create, change, send or delete anything. If asked to, explain that you can only read data and draft text for a person to act on.',
    '- Be concise and practical. Use short paragraphs or "- " bullet lists. Mention order references (e.g. ORD-…) when you talk about specific orders.',
    knowledge ? `\nBusiness notes from the owner (trusted reference):\n${knowledge}` : '\nNo business notes have been added yet (knowledge/ folder is empty).',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Reads the plain-text business notes on every task, so edits apply without a restart. */
export function loadKnowledge(dir: string): string {
  try {
    if (!existsSync(dir)) return '';
    let out = '';
    for (const f of readdirSync(dir).sort()) {
      if (!/\.(md|txt)$/i.test(f) || /^readme\.md$/i.test(f)) continue;
      const path = join(dir, f);
      if (!statSync(path).isFile()) continue;
      out += `\n--- ${f} ---\n${readFileSync(path, 'utf8').trim()}\n`;
      if (out.length > MAX_KNOWLEDGE_CHARS) return out.slice(0, MAX_KNOWLEDGE_CHARS) + '\n[notes truncated]';
    }
    return out.trim();
  } catch {
    return '';
  }
}
