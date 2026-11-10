// "Attention needed" (top bar bell, Connected Mode): failed connections, blocked or failed work,
// AI limits and overdue orders, each with a link to the record. Built by the server from live
// state for this account; dismissing an item only hides it in this browser until it changes.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AttentionItem, AttentionKind, AttentionLink, AttentionSeverity } from '../../../shared/live';
import { ATTENTION_KIND_LABEL } from '../../../shared/live';
import { formatManila } from '../../../shared/manila';
import type { LiveStore } from '../../live/store';
import { IconAlert, IconBell, IconClose } from '../icons';

export type AttentionOpen = (link: Exclude<AttentionLink, { kind: 'external' }>) => void;

const useLive = (store: LiveStore) => useSyncExternalStore(store.subscribe, store.getVersion);
const KINDS: AttentionKind[] = ['connection', 'limit', 'blocked', 'overdue'];
const SEVERITY_TEXT: Record<AttentionSeverity, string> = { critical: 'Urgent', warning: 'Check', info: 'Info' };

export function AttentionBell({ store, onOpen }: { store: LiveStore; onOpen: AttentionOpen }) {
  useLive(store);
  const [open, setOpen] = useState(false);
  const items = store.attentionItems;
  const urgent = items.some((i) => i.severity === 'critical');
  const count = items.filter((i) => i.severity !== 'info').length;
  return (
    <div className="settings-anchor">
      <button
        className={`icon-btn attn-btn ${open ? 'is-on' : ''}`}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void store.loadAttention();
        }}
        aria-label={count ? `Attention needed: ${count} item${count === 1 ? '' : 's'}${urgent ? ', some urgent' : ''}` : 'Attention needed: nothing new'}
        aria-expanded={open}
        title="Attention needed"
      >
        <IconBell />
        {count > 0 && <span className={`attn-badge ${urgent ? 'urgent' : ''}`}>{count > 99 ? '99+' : count}</span>}
      </button>
      {open && <AttentionMenu store={store} onOpen={onOpen} onClose={() => setOpen(false)} />}
    </div>
  );
}

function AttentionMenu({ store, onOpen, onClose }: { store: LiveStore; onOpen: AttentionOpen; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.attn-btn')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const r = store.attention;
  const items = store.attentionItems;
  const hidden = store.attentionDismissedCount;
  return (
    <div className="menu attn-menu" ref={ref} role="dialog" aria-label="Attention needed">
      <div className="row between">
        <div className="menu-title">Attention needed</div>
        <button className="btn sm ghost" onClick={() => void store.loadAttention(true)} disabled={store.attentionLoading}>
          {store.attentionLoading ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      {store.attentionError && <p className="photo-note small">{store.attentionError}</p>}
      {!r ? (
        <p className="muted small">Checking…</p>
      ) : items.length === 0 ? (
        <p className="attn-empty small">Nothing needs your attention right now.</p>
      ) : (
        <div className="attn-groups">
          {KINDS.map((k) => {
            const list = items.filter((i) => i.kind === k);
            if (!list.length) return null;
            return (
              <section key={k}>
                <h3>
                  {ATTENTION_KIND_LABEL[k]}
                  {k === 'overdue' && r.overdueTotal !== null && r.overdueTotal > list.length ? ` (${list.length} of ${r.overdueTotal})` : ` (${list.length})`}
                </h3>
                <ul>
                  {list.map((i) => (
                    <Item key={i.id} item={i} store={store} onOpen={(l) => (onOpen(l), onClose())} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {r && r.notes.length > 0 && (
        <ul className="mini-list">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div className="row between small muted attn-foot">
        <span>{r ? `Checked ${formatManila(r.asOf)}` : ''}</span>
        {hidden > 0 && (
          <button className="btn sm ghost" onClick={() => store.restoreAttention()}>
            Show {hidden} dismissed
          </button>
        )}
      </div>
    </div>
  );
}

function Item({ item: i, store, onOpen }: { item: AttentionItem; store: LiveStore; onOpen: AttentionOpen }) {
  const l = i.link;
  return (
    <li className={`attn-item sev-${i.severity}`}>
      <span className="attn-sev">
        {i.severity !== 'info' && <IconAlert size={12} />}
        {SEVERITY_TEXT[i.severity]}
      </span>
      <div className="attn-body">
        <b>{i.title}</b>
        <span className="small muted">{i.detail}</span>
        {l &&
          (l.kind === 'external' ? (
            <a className="attn-link small" href={l.url} target="_blank" rel="noopener noreferrer">
              {l.label} ↗
            </a>
          ) : (
            <button className="attn-link small" onClick={() => onOpen(l)}>
              {l.label} →
            </button>
          ))}
      </div>
      <button className="icon-btn sm attn-x" onClick={() => store.dismissAttention(i)} aria-label={`Dismiss: ${i.title}`} title="Dismiss (comes back if it changes)">
        <IconClose size={12} />
      </button>
    </li>
  );
}
