// The "brain" is the only place agent text is produced. The simulation engine and UI only
// ever talk to the AgentBrain interface, so a real AI service can be plugged in later by
// writing another implementation (e.g. one that calls your own backend) — no UI changes needed.
//
// This prototype ships with TemplateBrain only: predefined, clearly labelled template text.
// Nothing here calls a model or any network service.

import type { AgentId, TaskOutput } from '../sim/types';
import {
  DEMO_PRICE_NOTE,
  DEMO_QUOTE_LINES,
  INQUIRY_REQUIREMENTS,
  MARKETING_JOB,
  MOCK_ORDERS,
  SAMPLE_INQUIRY,
  reviewOrder,
} from '../data/mock';
import { AGENT_BY_ID } from './roster';

export type ComposeKind = 'inquiry-requirements' | 'quotation' | 'production-summary' | 'caption' | 'custom';

export interface ComposeRequest {
  kind: ComposeKind;
  agentId: AgentId;
  prompt?: string;
}

export interface AgentBrain {
  readonly label: string;
  compose(req: ComposeRequest): Promise<TaskOutput>;
}

export const TEMPLATE_LABEL = 'Template response (demo) — not AI-generated';

export class TemplateBrain implements AgentBrain {
  readonly label = 'Template responses (demo mode)';

  async compose(req: ComposeRequest): Promise<TaskOutput> {
    switch (req.kind) {
      case 'inquiry-requirements':
        return {
          title: 'Requirements checklist',
          source: 'template',
          body: `Inquiry: "${SAMPLE_INQUIRY.message}"\nSize and material are given. The items below were missing, so the sample customer's simulated answers were filled in. No real message was sent.`,
          checklist: INQUIRY_REQUIREMENTS,
        };
      case 'quotation':
        return {
          title: 'Quotation draft — 90 × 210 cm mahogany door',
          source: 'template',
          body: `Prepared for ${SAMPLE_INQUIRY.customer}. Draft only — requires approval and is never sent automatically.`,
          quote: { lines: DEMO_QUOTE_LINES, note: DEMO_PRICE_NOTE },
        };
      case 'production-summary': {
        const flags = MOCK_ORDERS.map((o) => ({ ref: o.ref, ...reviewOrder(o) }));
        const warn = flags.filter((f) => f.level === 'warn');
        return {
          title: 'Production review summary',
          source: 'template',
          body: `${MOCK_ORDERS.length} mock orders checked. ${warn.length} need attention: ${warn
            .map((w) => w.ref)
            .join(', ')}. The rest are on track.`,
          flags,
        };
      }
      case 'caption':
        return {
          title: 'Facebook caption draft',
          source: 'template',
          body:
            `Bagong gawa, bagong pasok!\n\n` +
            `Another ${MARKETING_JOB.item.toLowerCase()} finished in ${MARKETING_JOB.finish}, now installed at ${MARKETING_JOB.location}. ` +
            `Solid wood, clean lines, built to last.\n\n` +
            `Planning a new main door? Message us for a free quotation.\n` +
            `#WADFurniture #MahoganyDoor #CustomDoors`,
        };
      case 'custom':
        return customTemplate(req.agentId, req.prompt ?? '');
    }
  }
}

function customTemplate(agentId: AgentId, prompt: string): TaskOutput {
  const a = AGENT_BY_ID[agentId];
  const q = prompt.trim() || '(no details given)';
  const by: Record<AgentId, string> = {
    lia: `Reply draft (not sent):\n"Hi! Thanks for reaching out to WAD Furniture. To prepare your quotation, could you share the door size, design (plain, carved, or V-cut), finish, and delivery area?"\n\nNext: wait for the customer's details, then pass them to Marco.`,
    marco: `Quotation outline:\n1. Confirm size, design, and material\n2. List door slab, jamb, hardware, finish, installation\n3. Apply current price list (demo mode has placeholder values only)\n4. Send draft to Chief for approval`,
    paolo: `Production check:\n• ${MOCK_ORDERS.length} mock orders on the board\n• Flag anything overdue or without an update in ${5}+ days\n• Report flagged jobs to Chief`,
    nina: `Installation plan (mock):\n• Crew A — Tue, morning slot\n• Crew B — Thu, afternoon slot\n• Confirm site readiness with the customer before dispatch (not contacted in demo)`,
    bea: `Finance summary outline (mock figures):\n• Quotations issued this week: 6\n• Deposits received: 4\n• Balances due: 3\nFigures are placeholders for the demo.`,
    rosa: `Collections check (mock figures):\n• Finished orders with a balance: 2\n• Orders with no downpayment yet: 1\n• Reminder drafts are for review only — nothing is sent in demo mode.`,
    carlo: `Caption idea:\n"Crafted with care, built to last. Another custom WAD door is ready for its new home. Message us for a quotation!"\nNot published — for review only.`,
    dev: `Dev checklist:\n1. Reproduce the issue in a test copy\n2. Check recent changes and logs\n3. Fix, test, and note the change\nNo live systems are touched in demo mode.`,
    chief: `Coordination plan:\n1. Break the request into owner tasks\n2. Assign to the right agent\n3. Review outputs before anything goes out\n4. Approve or send back with notes`,
  };
  return {
    title: `${a.name}'s response`,
    source: 'template',
    body: `Request: "${q}"\n\n${by[agentId]}`,
  };
}
