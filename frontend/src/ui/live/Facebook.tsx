// Facebook Page posting with Carlo: a person previews, edits and approves every post.
// Post now, or schedule it for a day and time (Facebook's own scheduler keeps it, so it goes out
// even when the office is closed). Pending posts are read back from the Page.

import { useEffect, useState } from 'react';
import { FB_MAX_SCHEDULE_DAYS, FB_MIN_SCHEDULE_MINUTES, MAX_POST_CHARS } from '../../../shared/live';
import { addDays, formatManila, manilaDate } from '../../../shared/manila';
import type { LiveStore } from '../../live/store';
import { IconCamera, IconCheck, IconClose, IconRetry } from '../icons';
import { shrinkPhoto, useLive } from './LiveViews';
import type { PostWhen } from '../../live/caption';
export { captionFrom } from '../../live/caption';

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

/** Manila wall-clock date + time -> ISO instant (Manila is UTC+8 all year). */
const manilaToIso = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`).toISOString();

/** Why a scheduled time cannot be used, or null when Facebook will accept it. */
function scheduleProblemFor(iso: string): string | null {
  const t = Date.parse(iso);
  if (t < Date.now() + FB_MIN_SCHEDULE_MINUTES * 60_000) return `Pick a time at least ${FB_MIN_SCHEDULE_MINUTES} minutes from now.`;
  if (t > Date.now() + FB_MAX_SCHEDULE_DAYS * 86_400_000) return `Facebook can schedule at most ${FB_MAX_SCHEDULE_DAYS} days ahead.`;
  return null;
}

export function FacebookComposer({
  store,
  initialMessage = '',
  initialPhoto = null,
  initialWhen = null,
  onClose,
}: {
  store: LiveStore;
  initialMessage?: string;
  initialPhoto?: string | null;
  /** The time Carlo read from the request, to start from. */
  initialWhen?: PostWhen | null;
  onClose?: () => void;
}) {
  useLive(store);
  const today = manilaDate();
  const [message, setMessage] = useState(initialMessage);
  const [photo, setPhoto] = useState<string | null>(initialPhoto);
  const [mode, setMode] = useState<'now' | 'schedule'>(initialWhen?.kind === 'at' ? 'schedule' : 'now');
  const [date, setDate] = useState(initialWhen?.kind === 'at' ? initialWhen.date : addDays(today, 1));
  const [time, setTime] = useState(initialWhen?.kind === 'at' ? initialWhen.time : '09:00');
  const [checked, setChecked] = useState(false);
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ link: string | null; scheduledAt: string | null } | null>(null);
  const page = store.facebook?.pageName ?? 'your Facebook Page';

  // Any change after ticking the box needs a fresh confirmation (and a new request key).
  const changed = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setChecked(false);
    setKey(newKey());
    setError(null);
  };

  let scheduleIso: string | null = null;
  let scheduleProblem: string | null = null;
  if (mode === 'schedule') {
    if (!date || !time) scheduleProblem = 'Choose a date and time.';
    else {
      scheduleIso = manilaToIso(date, time);
      scheduleProblem = scheduleProblemFor(scheduleIso);
    }
  }
  const text = message.trim();
  const ready = !!text && text.length <= MAX_POST_CHARS && checked && !scheduleProblem && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const r = await store.postToFacebook({ key, message: text, photo: photo ?? undefined, scheduleAt: mode === 'schedule' ? scheduleIso! : undefined });
      setDone({ link: r.link, scheduledAt: r.scheduledAt });
      if (r.scheduledAt) void store.loadScheduled();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <div className="fb-composer stack">
        <p className="fb-done">
          <IconCheck size={15} /> {done.scheduledAt ? `Scheduled for ${formatManila(done.scheduledAt)} (Manila) on ${page}.` : `Posted on ${page}.`}
        </p>
        <div className="row wrap gap-s">
          {done.link && (
            <a className="btn sm" href={done.link} target="_blank" rel="noopener noreferrer">
              Open on Facebook
            </a>
          )}
          <button
            className="btn sm"
            onClick={() => {
              setDone(null);
              setChecked(false);
              setKey(newKey());
              setMessage('');
              setPhoto(null);
            }}
          >
            Write another
          </button>
          {onClose && (
            <button className="btn sm ghost" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    );

  return (
    <div className="fb-composer stack">
      <p className="muted small">
        Posting to <b>{page}</b>. Check the text and photo: this will be public.
      </p>
      <PhotoPicker photo={photo} setPhoto={changed(setPhoto)} />
      <label className="sr-only" htmlFor="fb-text">
        Post text
      </label>
      <textarea id="fb-text" rows={7} value={message} maxLength={MAX_POST_CHARS} onChange={(e) => changed(setMessage)(e.target.value)} placeholder="Write the post…" />
      <div className="row between muted small">
        <span>{text.length.toLocaleString()} / {MAX_POST_CHARS.toLocaleString()}</span>
      </div>
      <div className="fb-when" role="radiogroup" aria-label="When to post">
        <label>
          <input type="radio" name="fb-when" checked={mode === 'now'} onChange={() => changed(setMode)('now')} /> Post now
        </label>
        <label>
          <input type="radio" name="fb-when" checked={mode === 'schedule'} onChange={() => changed(setMode)('schedule')} /> Schedule
        </label>
      </div>
      {mode === 'schedule' && (
        <div className="row wrap gap-s fb-date">
          <label className="sr-only" htmlFor="fb-date">
            Date
          </label>
          <input id="fb-date" type="date" value={date} min={today} max={addDays(today, FB_MAX_SCHEDULE_DAYS)} onChange={(e) => changed(setDate)(e.target.value)} />
          <label className="sr-only" htmlFor="fb-time">
            Time
          </label>
          <input id="fb-time" type="time" value={time} step={300} onChange={(e) => changed(setTime)(e.target.value)} />
          <span className="tz">Asia/Manila</span>
        </div>
      )}
      {scheduleProblem && <p className="photo-note small">{scheduleProblem}</p>}
      <label className="fb-confirm">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I checked the text and photo, and approve this post.
      </label>
      {error && (
        <p className="photo-note small" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap gap-s">
        <button className="btn primary" disabled={!ready} onClick={() => void submit()}>
          {busy ? 'Sending…' : mode === 'now' ? `Post now to ${page}` : scheduleIso && !scheduleProblem ? `Schedule for ${formatManila(scheduleIso)}` : 'Schedule'}
        </button>
        {onClose && (
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function PhotoPicker({ photo, setPhoto }: { photo: string | null; setPhoto: (p: string | null) => void }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = 'fb-photo-input';
  return (
    <div className="fb-photo">
      {photo ? (
        <div className="fb-photo-preview">
          <img src={photo} alt="Photo for the post" />
          <button type="button" className="icon-btn" aria-label="Remove photo" onClick={() => setPhoto(null)}>
            <IconClose size={12} />
          </button>
        </div>
      ) : (
        <label className="btn sm" htmlFor={id} aria-disabled={busy}>
          <IconCamera size={15} /> {busy ? 'Reading…' : 'Add a photo'}
        </label>
      )}
      <input
        id={id}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy(true);
          setNote(null);
          try {
            setPhoto(await shrinkPhoto(f));
          } catch (err) {
            setNote((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
      {note && <p className="photo-note small">{note}</p>}
    </div>
  );
}

/**
 * Carlo's prepared post, from a task like "make a short caption for this door and schedule it
 * Saturday 9am": the photo, the caption and the time he read from the request. Nothing is sent
 * until a person clicks Approve. The time is checked again here, by code.
 */
export function CarloReadyPost({
  store,
  jobId,
  message,
  photo,
  when,
}: {
  store: LiveStore;
  jobId: string;
  message: string;
  photo: string | null;
  when: PostWhen;
}) {
  useLive(store);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ link: string | null; scheduledAt: string | null } | null>(null);
  const page = store.facebook?.pageName ?? 'your Facebook Page';
  const iso = when.kind === 'at' ? manilaToIso(when.date, when.time) : null;
  const problem = iso ? scheduleProblemFor(iso) : null;
  const text = message.trim();
  const tooLong = text.length > MAX_POST_CHARS;

  if (editing)
    return <FacebookComposer store={store} initialMessage={message} initialPhoto={photo} initialWhen={when} onClose={() => setEditing(false)} />;
  if (done)
    return (
      <div className="fb-composer stack">
        <p className="fb-done">
          <IconCheck size={15} /> {done.scheduledAt ? `Scheduled for ${formatManila(done.scheduledAt)} (Manila) on ${page}.` : `Posted on ${page}.`}
        </p>
        {done.link && (
          <a className="btn sm" href={done.link} target="_blank" rel="noopener noreferrer">
            Open on Facebook
          </a>
        )}
      </div>
    );

  const approve = async () => {
    if (busy || problem || !text || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      // One key per Carlo task: a second click (or a resend) never makes a second post.
      const r = await store.postToFacebook({ key: `carlo-${jobId}`, message: text, photo: photo ?? undefined, scheduleAt: iso ?? undefined });
      setDone({ link: r.link, scheduledAt: r.scheduledAt });
      if (r.scheduledAt) void store.loadScheduled();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fb-ready stack">
      <p className="fb-ready-head">
        <b>Ready for your approval</b> · {page}
      </p>
      <div className="fb-ready-body">
        {photo && <img src={photo} alt="Photo for the post" />}
        <p className="fb-ready-text">{text || '(no caption)'}</p>
      </div>
      <p className="fb-ready-when">
        {when.kind === 'now' ? 'When: post now' : `When: ${formatManila(iso!)} (Manila)`}
      </p>
      {problem && <p className="photo-note small">Carlo picked a time Facebook won't accept. {problem} Click Edit to change it.</p>}
      {tooLong && <p className="photo-note small">The caption is longer than {MAX_POST_CHARS.toLocaleString()} characters. Click Edit to shorten it.</p>}
      {!photo && <p className="muted small">No photo is attached (photos are not kept after a page reload). Click Edit to add one.</p>}
      {error && (
        <p className="photo-note small" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap gap-s">
        <button className="btn primary" disabled={busy || !!problem || !text || tooLong} onClick={() => void approve()}>
          <IconCheck size={15} /> {busy ? 'Sending…' : when.kind === 'now' ? 'Approve & post now' : 'Approve & schedule'}
        </button>
        <button className="btn" disabled={busy} onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
      <p className="muted small">Check the photo, text and time: clicking Approve publishes it {when.kind === 'now' ? 'right away' : 'at that time'}. You can still cancel a scheduled post under Pending posts.</p>
    </div>
  );
}

/** Posts waiting in the Page's schedule (from Facebook, so Meta Business Suite posts show too). */
export function FacebookPending({ store }: { store: LiveStore }) {
  useLive(store);
  const [busyId, setBusyId] = useState<string | null>(null);
  useEffect(() => {
    if (store.scheduledPosts === null) void store.loadScheduled();
  }, [store]);
  const posts = store.scheduledPosts;
  return (
    <div className="stack">
      <div className="row between">
        <h4 className="fb-h">Pending posts</h4>
        <button className="btn sm ghost" onClick={() => void store.loadScheduled()} aria-label="Refresh pending posts">
          <IconRetry size={13} /> Refresh
        </button>
      </div>
      {store.fbError && <p className="photo-note small">{store.fbError}</p>}
      {posts === null ? (
        <p className="muted small">Loading…</p>
      ) : posts.length === 0 ? (
        <p className="muted small">No posts are scheduled on the Page.</p>
      ) : (
        <ul className="flags stacked">
          {posts.map((p) => (
            <li key={p.id}>
              <b>{p.scheduledAt ? `${formatManila(p.scheduledAt)} (Manila)` : 'Scheduled'}</b>
              <span className="fb-msg">{p.message || '(no text)'}</span>
              <span className="row wrap gap-s">
                {p.hasPicture && <span className="tag">with photo</span>}
                {p.link && (
                  <a className="btn sm ghost" href={p.link} target="_blank" rel="noopener noreferrer">
                    Open
                  </a>
                )}
                <button
                  className="btn sm"
                  disabled={busyId === p.id}
                  onClick={async () => {
                    if (!window.confirm('Cancel this scheduled post? It will be deleted from the Page schedule.')) return;
                    setBusyId(p.id);
                    await store.cancelScheduled(p.id);
                    setBusyId(null);
                  }}
                >
                  {busyId === p.id ? 'Cancelling…' : 'Cancel post'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Carlo's panel: Facebook status, a new post, and the pending posts. */
export function FacebookPanel({ store }: { store: LiveStore }) {
  useLive(store);
  const [open, setOpen] = useState(false);
  const can = store.canPostFacebook();
  if (!store.user?.permissions.includes('social:post')) return null;
  return (
    <section>
      <h3>Facebook Page</h3>
      {!can.ok ? (
        <p className="muted small">{can.reason}</p>
      ) : (
        <>
          <p className="muted small">
            Carlo drafts, you approve. Posts go to <b>{store.facebook?.pageName ?? 'your Page'}</b> only when you click Post or Schedule.
          </p>
          {open ? (
            <FacebookComposer store={store} onClose={() => setOpen(false)} />
          ) : (
            <button className="btn sm" onClick={() => setOpen(true)}>
              New post
            </button>
          )}
          <FacebookPending store={store} />
        </>
      )}
    </section>
  );
}
