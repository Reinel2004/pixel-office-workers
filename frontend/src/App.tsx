import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TemplateBrain } from './agents/brain';
import { AGENT_BY_ID } from './agents/roster';
import { Bus, type Insets } from './bridge';
import { OfficeCanvas } from './office/OfficeCanvas';
import { Office3D } from './office/Office3D';
import { LiveStore } from './live/store';
import { Engine, type StorageLike } from './sim/engine';
import { playCue } from './sim/sound';
import type { AgentId, Selection } from './sim/types';
import { ActivityPanel } from './ui/ActivityPanel';
import { BottomBar } from './ui/BottomBar';
import { DetailPanel } from './ui/DetailPanel';
import { IconFit, IconMinus, IconPlus } from './ui/icons';
import { useEngine } from './ui/shared';
import { ConnectGate, ConnectedBar, LiveFeed, useLive } from './ui/live/LiveViews';
import { TopBar } from './ui/TopBar';
import { DiscussionDialog } from './ui/Discussions';
import { UiReviewDialog } from './ui/UiReview';

function safeStorage(): StorageLike | null {
  try {
    const k = '__wad_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    return null;
  }
}

function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

export default function App() {
  const prefersReduced = useMedia('(prefers-reduced-motion: reduce)');
  const engine = useMemo(() => {
    const storage = safeStorage();
    const fresh = !storage?.getItem('wad-ai-office:v1');
    const e = new Engine(new TemplateBrain(), storage, {
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      feedOpen: window.innerWidth >= 760,
    });
    if (fresh) e.addLog('Welcome to WAD AI Office. All agents are simulated — try a demo workflow below.', 'info');
    return e;
  }, []);
  const bus = useMemo(() => new Bus(), []);
  const live = useMemo(() => new LiveStore(engine), [engine]);
  useEngine(engine);
  useLive(live);
  const connected = engine.connected;

  // Connected Mode: check for the server and an existing session.
  useEffect(() => {
    if (connected && (live.server === 'unknown' || live.server === 'unreachable')) void live.init();
  }, [connected, live]);

  const mobile = useMedia('(max-width: 759px)');
  const [selection, setSelectionState] = useState<Selection>(null);
  const [progress, setProgress] = useState(0.05);
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [view3d, setView3d] = useState(() => { try { return window.localStorage.getItem('wad-view3d') === '1'; } catch { return false; } });
  const toggleView = () => setView3d((v) => { const n = !v; try { window.localStorage.setItem('wad-view3d', n ? '1' : '0'); } catch { /* ignore */ } return n; });
  const [assignAgent, setAssignAgent] = useState<AgentId>('lia');
  const [focusSignal, setFocusSignal] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [bottomH, setBottomH] = useState(110);
  const feedOpen = engine.settings.feedOpen;

  // OS-level reduced motion always wins when switched on.
  useEffect(() => {
    if (prefersReduced && !engine.settings.reducedMotion) engine.updateSettings({ reducedMotion: true });
  }, [prefersReduced, engine]);

  useEffect(() => {
    engine.onCue = (cue) => {
      if (engine.settings.sound) playCue(cue);
    };
    return () => {
      engine.onCue = null;
    };
  }, [engine]);

  const setSelection = useCallback(
    (s: Selection) => {
      setSelectionState(s);
      bus.emit('scene:selection', { selection: s });
    },
    [bus],
  );

  useEffect(() => {
    const offs = [
      bus.on('scene:progress', ({ value }) => setProgress(value)),
      bus.on('scene:ready', () => {
        setReady(true);
        requestAnimationFrame(() => bus.emit('camera:reset', { animate: false, initial: true }));
      }),
      bus.on('scene:zoom', ({ zoom }) => setZoom(zoom)),
      bus.on('scene:pick', (p) => {
        if (p.kind === 'none') setSelection(null);
        else setSelection(p.kind === 'agent' ? { kind: 'agent', id: p.id } : { kind: 'room', id: p.id });
        if (engine.settings.sound) playCue('click');
      }),
    ];
    return () => offs.forEach((o) => o());
  }, [bus, engine, setSelection]);

  useLayoutEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBottomH(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const insets: Insets = useMemo(
    () => ({
      top: 56,
      bottom: bottomH + 20,
      left: mobile ? 8 : 16,
      right: !mobile && feedOpen ? 340 : mobile ? 8 : 64,
    }),
    [bottomH, mobile, feedOpen],
  );

  // Refit when the layout around the office changes (feed toggled, rotation).
  const firstFit = useRef(true);
  useEffect(() => {
    if (!ready) return;
    if (firstFit.current) {
      firstFit.current = false;
      return;
    }
    bus.emit('camera:insets', insets);
    bus.emit('camera:reset', { animate: true, initial: true });
  }, [ready, feedOpen, mobile, bus, insets]);

  const openTask = (id: string) => setSelection({ kind: 'task', id });
  const openJob = (id: string) => setSelection({ kind: 'job', id });
  const openDiscussion = (id: string) => setSelection({ kind: 'discussion', id });
  const [discussOpen, setDiscussOpen] = useState(false);
  const openUiReview = (id: string) => setSelection({ kind: 'uireview', id });
  const [uiOpen, setUiOpen] = useState(false);
  const setMode = (m: 'demo' | 'connected') => {
    engine.setMode(m);
    if (m === 'connected') void live.loadWorkshop(true); // already signed in: re-read the shop numbers
    if (m === 'connected' && live.server === 'signed_in') {
      void live.loadDiscussions(); // gather the team again if one is running
      void live.loadUiReviews();
    }
    setSelection(null);
  };
  const onAssign = (id: AgentId) => {
    setAssignAgent(id);
    setFocusSignal((n) => n + 1);
    if (mobile) setSelection(null);
  };

  const pending = connected ? undefined : engine.tasks.find((t) => t.status === 'awaiting_approval');
  const showBanner = pending && !(selection?.kind === 'task' && selection.id === pending.id);

  return (
    <div
      className={`app ${engine.paused ? 'is-paused' : ''} ${engine.settings.reducedMotion ? 'reduced' : ''}`}
      style={{ ['--bottom' as string]: `${bottomH + 24}px` }}
    >
      {view3d ? <Office3D key="3d" engine={engine} bus={bus} insets={insets} /> : <OfficeCanvas key="2d" engine={engine} bus={bus} insets={insets} />}
      <div className="vignette" aria-hidden="true" />

      <TopBar
        engine={engine}
        live={live}
        onSetMode={setMode}
        onOpenApproval={openTask}
        onResetView={() => bus.emit('camera:reset', { animate: true })}
        compact={mobile}
        onOpenAttention={(l) => {
          if (l.kind === 'job') openJob(l.id);
          else if (l.kind === 'discussion') openDiscussion(l.id);
          else if (l.kind === 'uireview') openUiReview(l.id);
          else if (l.kind === 'systems') live.showFeedTab('systems');
        }}
      />

      {showBanner && pending && (
        <div className="banner" role="status">
          <span className="pulse" />
          <span>
            <b>{AGENT_BY_ID[pending.approval!.agent].name}</b> is waiting for your approval
            {mobile ? '' : <>: {pending.approval!.title}</>}
          </span>
          <button className="btn sm warn" onClick={() => openTask(pending.id)}>
            Review
          </button>
        </div>
      )}

      {engine.paused && (
        <div className="paused-tag" role="status">
          {connected ? 'Animations paused — live reports keep running on the server' : 'Simulation paused'}
        </div>
      )}

      <DetailPanel
        engine={engine}
        selection={selection}
        setSelection={setSelection}
        onAssign={onAssign}
        onLocate={(id) => bus.emit('camera:focusAgent', { id })}
        mobile={mobile}
        live={live}
      />

      {connected ? (
        <LiveFeed store={live} open={feedOpen} setOpen={(o) => engine.updateSettings({ feedOpen: o })} onOpenJob={openJob} onOpenDiscussion={openDiscussion} onOpenUiReview={openUiReview} mobile={mobile} />
      ) : (
        <ActivityPanel engine={engine} open={feedOpen} setOpen={(o) => engine.updateSettings({ feedOpen: o })} onOpenTask={openTask} onOpenDiscussion={openDiscussion} onOpenUiReview={openUiReview} mobile={mobile} />
      )}

      <div className="camera-controls" style={{ bottom: bottomH + 20, right: !mobile && feedOpen ? 340 : 12 }}>
        <button className="icon-btn view-toggle" onClick={toggleView} aria-label="Switch 2D or 3D view" title="Switch 2D / 3D view">{view3d ? '2D' : '3D'}</button>
        <button className="icon-btn" onClick={() => bus.emit('camera:zoom', { factor: 1.25 })} aria-label="Zoom in" title="Zoom in">
          <IconPlus />
        </button>
        <span className="zoom-val" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button className="icon-btn" onClick={() => bus.emit('camera:zoom', { factor: 0.8 })} aria-label="Zoom out" title="Zoom out">
          <IconMinus />
        </button>
        <button className="icon-btn" onClick={() => bus.emit('camera:reset', { animate: true })} aria-label="Reset view" title="Reset view">
          <IconFit />
        </button>
      </div>

      <BottomBar
        ref={bottomRef}
        engine={engine}
        agent={assignAgent}
        setAgent={setAssignAgent}
        focusSignal={focusSignal}
        onStarted={() => undefined}
        onDiscuss={() => setDiscussOpen(true)}
        onUiReview={() => setUiOpen(true)}
        connectedContent={
          <ConnectedBar
            store={live}
            onOpenJob={openJob}
            agent={assignAgent}
            setAgent={setAssignAgent}
            focusSignal={focusSignal}
            onDiscuss={() => setDiscussOpen(true)}
            onUiReview={() => setUiOpen(true)}
          />
        }
      />

      {discussOpen && <DiscussionDialog engine={engine} live={live} onClose={() => setDiscussOpen(false)} onOpen={openDiscussion} />}
      {uiOpen && <UiReviewDialog engine={engine} live={live} onClose={() => setUiOpen(false)} onOpen={openUiReview} />}

      {connected && ready && <ConnectGate store={live} onDemo={() => setMode('demo')} />}

      {!ready && (
        <div className="loading" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="loading-card">
            <svg width="64" height="48" viewBox="0 0 64 48" aria-hidden="true">
              <path d="M32 4l28 14-28 14L4 18z" fill="#5fe0d2" opacity=".85" />
              <path d="M4 18v10l28 14V32z" fill="#3aa79b" />
              <path d="M60 18v10L32 42V32z" fill="#2b7d74" />
            </svg>
            <b>Setting up the office…</b>
            <div className="bar">
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span className="muted small">Placing desks and waking up the agents</span>
          </div>
        </div>
      )}
    </div>
  );
}

