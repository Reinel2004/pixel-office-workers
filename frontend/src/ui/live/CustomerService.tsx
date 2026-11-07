// Joy, Customer Service: paste a customer's message, optionally pick their order, and get a
// reply to check and send yourself. Nothing is sent from the office.
//
// Privacy: phone numbers and emails are removed on the server before the AI sees the message.
// The AI gets the picked order's facts by order number only; the customer's name is filled in
// here, in the browser, when you copy the reply.

import { useMemo, useState } from 'react';
import type { Job } from '../../../shared/live';
import { MAX_CS_PROMPT_CHARS } from '../../../shared/live';
import { replyFrom } from '../../live/caption';
import type { LiveStore } from '../../live/store';
import { IconCheck, IconRetry, IconSend } from '../icons';
import { useLive } from './LiveViews';

const MAX_MESSAGE = 1500;
const MAX_NOTE = 300;

export function CustomerReplyPanel({ store, onOpenJob }: { store: LiveStore; onOpenJob: (id: string) => void }) {
  useLive(store);
  const [message, setMessage] = useState('');
  const [note, setNote] = useState('');
  const [orderRef, setOrderRef] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const assign = store.canAssign();
  const canOrders = !!store.user?.permissions.includes('orders:read');
  const picks = store.orderPicks;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = picks ?? [];
    return (q ? list.filter((o) => o.ref.toLowerCase().includes(q) || (o.customer ?? '').toLowerCase().includes(q)) : list).slice(0, 200);
  }, [picks, filter]);
  const picked = picks?.find((o) => o.ref === orderRef) ?? null;

  const text = message.trim();
  const prompt = `Customer's message: """${text}"""${note.trim() ? ` Staff note: ${note.trim()}` : ''}`;
  const ready = assign.ok && !!text && prompt.length <= MAX_CS_PROMPT_CHARS && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    const job = await store.submitAi('joy', prompt, undefined, orderRef || undefined);
    setBusy(false);
    if (job) {
      setMessage('');
      setNote('');
      onOpenJob(job.id);
    }
  };

  return (
    <section className="cs-panel stack">
      <h3>Customer reply</h3>
      <p className="muted small">
        Paste the customer&apos;s message from Messenger, Viber, SMS or email. Joy drafts a reply; you check it and send it yourself.
      </p>
      <label className="sr-only" htmlFor="cs-message">
        Customer&apos;s message
      </label>
      <textarea
        id="cs-message"
        rows={5}
        value={message}
        maxLength={MAX_MESSAGE}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="e.g. Hi po, kumusta na po yung door namin? Kailan po ma-deliver?"
        disabled={!assign.ok}
      />
      <p className="muted small">
        Phone numbers and emails are removed automatically. Please delete the customer&apos;s name and address before pasting.
      </p>

      {canOrders && (
        <div className="cs-order stack">
          <div className="row between">
            <b className="small">Customer&apos;s order (optional)</b>
            {picks && (
              <button type="button" className="btn sm ghost" onClick={() => void store.loadOrderPicks()} aria-label="Reload open orders">
                <IconRetry size={13} /> Reload
              </button>
            )}
          </div>
          {!picks ? (
            <button type="button" className="btn sm" onClick={() => void store.loadOrderPicks()} disabled={!assign.ok}>
              Load open orders
            </button>
          ) : (
            <>
              <label className="sr-only" htmlFor="cs-filter">
                Search orders
              </label>
              <input id="cs-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search by customer name or order number" autoComplete="off" />
              <label className="sr-only" htmlFor="cs-pick">
                Order
              </label>
              <select id="cs-pick" value={orderRef} onChange={(e) => setOrderRef(e.target.value)}>
                <option value="">No order: general question</option>
                {picked && !shown.includes(picked) && (
                  <option value={picked.ref}>
                    {label(picked)}
                  </option>
                )}
                {shown.map((o) => (
                  <option key={o.ref} value={o.ref}>
                    {label(o)}
                  </option>
                ))}
              </select>
              {picks.length === 0 && <p className="muted small">There are no open orders.</p>}
              <p className="muted small">
                {picked
                  ? `Joy will see this order's status, stage and due date${store.user?.permissions.includes('finance:read') ? ', and its balance' : ''}, by order number only.`
                  : 'Pick the order only when you are sure it is this customer\'s. Delivered orders are not listed.'}
              </p>
            </>
          )}
          {store.orderPicksError && <p className="photo-note small">{store.orderPicksError}</p>}
        </div>
      )}

      <label className="sr-only" htmlFor="cs-note">
        Note for Joy
      </label>
      <input
        id="cs-note"
        value={note}
        maxLength={MAX_NOTE}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note for Joy, e.g. offer delivery next week, reply in English"
        autoComplete="off"
        disabled={!assign.ok}
      />
      <button className="btn primary" disabled={!ready} title={assign.reason} onClick={() => void submit()}>
        <IconSend size={15} /> {busy ? 'Sending to Joy…' : 'Draft reply'}
      </button>
    </section>
  );
}

const label = (o: { ref: string; customer: string | null; status: string; dueDate: string | null }) =>
  `${o.customer ?? '(no name)'} · ${o.ref} · ${o.status}${o.dueDate ? ` · due ${o.dueDate}` : ''}`;

/** Under Joy's finished answer: copy just the reply, with the customer's name filled in. */
export function CopyReply({ job }: { job: Job }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const r = job.steps[0]?.result;
  const customer = job.orderRef ? r?.customers?.[job.orderRef] : null;
  const reply = replyFrom(r?.answer ?? '', customer);
  if (!reply) return null;
  return (
    <section className="stack">
      <h3>Reply to send</h3>
      <pre className="cs-reply">{reply}</pre>
      <div className="row wrap gap-s">
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(reply);
              setCopied('ok');
            } catch {
              setCopied('fail');
            }
          }}
        >
          {copied === 'ok' ? <IconCheck size={15} /> : null} {copied === 'ok' ? 'Copied' : 'Copy reply'}
        </button>
      </div>
      {copied === 'fail' && <p className="photo-note small">Copy was blocked by the browser. Select the text above and copy it.</p>}
      <p className="muted small">
        Check the reply before sending{customer ? '' : ', and replace [Customer name]'}. Nothing was sent to the customer.
      </p>
    </section>
  );
}
