// Tess, Quality Control Assistant: pick an order, get its inspection checklist (built by code from
// the order's specifications in WAD Order Management), tick it off, copy or print it, or ask Tess
// to rewrite it (e.g. in Tagalog for the carpenters). Demo Mode uses two sample orders.

import { useMemo, useState } from 'react';
import type { CheckArea, InspectionChecklist, OrderSpec } from '../../../shared/live';
import { CHECK_AREAS } from '../../../shared/live';
import { buildChecklist, checklistText } from '../../../shared/qc';
import type { LiveStore } from '../../live/store';
import type { Engine } from '../../sim/engine';
import { IconCheck, IconClipboard, IconCopy, IconRetry, IconSend } from '../icons';
import { useLive } from './LiveViews';

const AREA_LABEL: Record<CheckArea, string> = { dimensions: 'Dimensions', design: 'Design & wood', finish: 'Finish', jamb: 'Jamb (hamba)', hardware: 'Hardware', general: 'General' };

export function ChecklistPanel({ store, onOpenJob }: { store: LiveStore; onOpenJob: (id: string) => void }) {
  useLive(store);
  const [ref, setRef] = useState('');
  const [filter, setFilter] = useState('');
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState(false);
  const canOrders = !!store.user?.permissions.includes('orders:read');
  const picks = store.orderPicks;
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = picks ?? [];
    return (q ? list.filter((o) => o.ref.toLowerCase().includes(q) || (o.customer ?? '').toLowerCase().includes(q)) : list).slice(0, 200);
  }, [picks, filter]);
  const picked = picks?.find((o) => o.ref === ref) ?? null;
  const checklist = ref ? store.checklists.get(ref) : undefined;
  const assign = store.canAssign();

  if (!canOrders)
    return (
      <section className="cs-panel stack">
        <h3>Inspection checklist</h3>
        <p className="muted small">Your account cannot read orders, so Tess cannot build checklists for it.</p>
      </section>
    );

  const askTess = async () => {
    if (!ref || !ask.trim() || busy) return;
    setBusy(true);
    const job = await store.submitAi('tess', ask.trim(), undefined, ref);
    setBusy(false);
    if (job) {
      setAsk('');
      onOpenJob(job.id);
    }
  };

  return (
    <section className="cs-panel stack">
      <h3>
        <IconClipboard size={16} /> Inspection checklist
      </h3>
      <p className="muted small">Pick an order: Tess builds the checklist by code from its specifications in WAD Order Management. Nothing is guessed.</p>
      {!picks ? (
        <button type="button" className="btn sm" onClick={() => void store.loadOrderPicks()}>
          Load open orders
        </button>
      ) : (
        <>
          <div className="row gap-s">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search by customer or order number" aria-label="Search orders" autoComplete="off" />
            <button type="button" className="btn sm ghost" onClick={() => void store.loadOrderPicks()} aria-label="Reload open orders">
              <IconRetry size={13} />
            </button>
          </div>
          <select value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Order">
            <option value="">Choose an order…</option>
            {picked && !shown.includes(picked) && <option value={picked.ref}>{label(picked)}</option>}
            {shown.map((o) => (
              <option key={o.ref} value={o.ref}>
                {label(o)}
              </option>
            ))}
          </select>
          <button className="btn primary sm" disabled={!ref || !!store.checklistLoading} onClick={() => void store.loadChecklist(ref)}>
            <IconClipboard size={14} /> {store.checklistLoading === ref ? 'Building…' : checklist ? 'Build again' : 'Build checklist'}
          </button>
        </>
      )}
      {store.orderPicksError && <p className="photo-note small">{store.orderPicksError}</p>}
      {store.checklistError && <p className="photo-note small">{store.checklistError}</p>}
      {checklist && <ChecklistView c={checklist} customer={picked?.customer ?? null} />}
      {ref && (
        <div className="stack">
          <label className="small" htmlFor="qc-ask">
            Ask Tess about this order (optional, AI)
          </label>
          <div className="row gap-s">
            <input id="qc-ask" value={ask} maxLength={300} onChange={(e) => setAsk(e.target.value)} placeholder="e.g. Write this checklist in Tagalog for the carpenters" disabled={!assign.ok} />
            <button className="btn sm" disabled={!assign.ok || !ask.trim() || busy} title={assign.reason} onClick={() => void askTess()}>
              <IconSend size={14} />
            </button>
          </div>
          <p className="muted small">Tess sees the checklist above, never the staff notes or the customer's name.</p>
        </div>
      )}
    </section>
  );
}

const label = (o: { ref: string; customer: string | null; status: string; dueDate: string | null }) =>
  `${o.customer ?? '(no name)'} · ${o.ref} · ${o.status}${o.dueDate ? ` · due ${o.dueDate}` : ''}`;

/** The checklist with boxes to tick (in this browser only), copy and print. */
export function ChecklistView({ c, customer }: { c: InspectionChecklist; customer: string | null }) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const total = c.groups.reduce((n, g) => n + g.items.length, 0);
  const text = checklistText(c, customer);
  const print = () => {
    const w = window.open('', '_blank', 'width=720,height=900');
    if (!w) return setCopied('fail');
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.document.write(`<!doctype html><title>${c.ref} checklist</title><pre style="font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap">${esc}</pre>`);
    w.document.close();
    w.focus();
    w.print();
  };
  return (
    <div className="stack qc">
      <div className="row between wrap">
        <b>
          {c.ref}
          {customer ? ` · ${customer}` : ''}
        </b>
        <span className="muted small">
          {c.pieces} piece(s){c.status ? ` · ${c.status}` : ''}
          {c.dueDate ? ` · due ${c.dueDate}` : ''} · {ticked.size}/{total} checked
        </span>
      </div>
      <span className="tag code-tag">{c.source === 'demo' ? 'Demo sample order' : 'Built by code from WAD Order Management — no AI'}</span>
      {c.groups.map((g, gi) => (
        <article key={gi} className="output">
          <header>
            <b>
              {g.qty} × {g.label}
            </b>
            {g.stages.length > 0 && <span className="muted small">{g.stages.join(', ')}</span>}
          </header>
          {CHECK_AREAS.map((area) => {
            const items = g.items.filter((i) => i.area === area);
            if (!items.length) return null;
            return (
              <div key={area}>
                <h4>{AREA_LABEL[area]}</h4>
                <ul className="qc-items">
                  {items.map((i) => (
                    <li key={i.id} className={i.missing ? 'missing' : ''}>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={ticked.has(i.id)}
                          onChange={() =>
                            setTicked((t) => {
                              const n = new Set(t);
                              if (n.has(i.id)) n.delete(i.id);
                              else n.add(i.id);
                              return n;
                            })
                          }
                        />
                        <span>
                          {i.text}
                          {i.expected && <b className="qc-expected">{i.expected}</b>}
                          {i.missing && <span className="tag sev-high">not recorded — confirm with sales</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {g.notes.map((n, i) => (
            <p key={i} className="note">
              Notes: {n}
            </p>
          ))}
        </article>
      ))}
      {c.warnings.length > 0 && (
        <ul className="mini-list notes">
          {c.warnings.map((w) => (
            <li key={w} className="warn">
              {w}
            </li>
          ))}
        </ul>
      )}
      <div className="row wrap gap-s">
        <button
          className="btn sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied('ok');
            } catch {
              setCopied('fail');
            }
          }}
        >
          {copied === 'ok' ? <IconCheck size={14} /> : <IconCopy size={14} />} {copied === 'ok' ? 'Copied' : 'Copy'}
        </button>
        <button className="btn sm" onClick={print}>
          Print
        </button>
      </div>
      {copied === 'fail' && <p className="photo-note small">The browser blocked this. Select the text and copy it instead.</p>}
      <p className="muted small">Ticks are kept only on this screen. Nothing is saved to WAD Order Management.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Demo Mode
const DEMO_SPECS: OrderSpec[] = [
  {
    ref: 'ORD-DEMO101',
    status: 'In Progress',
    dueDate: null,
    truncated: false,
    pieces: [0, 1].map(() => ({
      category: 'Door',
      type: 'Panel Door',
      size: '36 x 84',
      thickness: '1 3/4"',
      wood: 'Narra',
      finish: 'With Varnish',
      jamb: 'With Hamba',
      jambWood: 'Mahogany',
      jambSize: '2 x 6',
      cnc: true,
      tableShape: null,
      length: null,
      width: null,
      height: null,
      notes: 'Sample note: 3 hinges and a lockset per door',
      hasDesignPhoto: true,
      hasColorSample: true,
      stage: 'finishing',
    })),
  },
  {
    ref: 'ORD-DEMO102',
    status: 'Pending',
    dueDate: null,
    truncated: false,
    pieces: [
      { category: 'Dining', type: 'Dining table', size: null, thickness: null, wood: 'Acacia', finish: null, jamb: null, jambWood: null, jambSize: null, cnc: false, tableShape: 'Rectangle', length: '72', width: '36', height: null, notes: null, hasDesignPhoto: false, hasColorSample: false, stage: 'production' },
    ],
  },
];

export function DemoChecklistPanel({ engine }: { engine: Engine }) {
  const [ref, setRef] = useState(DEMO_SPECS[0].ref);
  const [built, setBuilt] = useState<InspectionChecklist | null>(null);
  return (
    <section className="cs-panel stack">
      <h3>
        <IconClipboard size={16} /> Inspection checklist (demo)
      </h3>
      <p className="muted small">Sample orders only. In Connected Mode, Tess reads the real order specifications from WAD Order Management.</p>
      <select value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Sample order">
        <option value="ORD-DEMO101">ORD-DEMO101 · 2 panel doors with jamb (sample)</option>
        <option value="ORD-DEMO102">ORD-DEMO102 · dining table, some details missing (sample)</option>
      </select>
      <button
        className="btn primary sm"
        onClick={() => {
          setBuilt(buildChecklist(DEMO_SPECS.find((s) => s.ref === ref)!, new Date().toISOString(), 'demo'));
          engine.visitShop('tess');
          engine.leaveShop('tess');
        }}
      >
        <IconClipboard size={14} /> Build checklist
      </button>
      {built && <ChecklistView key={built.ref + built.builtAt} c={built} customer={null} />}
    </section>
  );
}
