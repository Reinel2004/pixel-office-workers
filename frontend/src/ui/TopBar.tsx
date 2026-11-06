import { useEffect, useRef, useState } from 'react';
import type { LiveStore } from '../live/store';
import type { Engine } from '../sim/engine';
import { useLive } from './live/LiveViews';
import { IconGear, IconMute, IconPause, IconPlay, IconSound } from './icons';
import { useEngine } from './shared';

interface Props {
  engine: Engine;
  live: LiveStore;
  onSetMode: (m: 'demo' | 'connected') => void;
  onOpenApproval: (taskId: string) => void;
  onResetView: () => void;
  compact: boolean;
}

export function TopBar({ engine, live, onSetMode, onOpenApproval, onResetView, compact }: Props) {
  useEngine(engine);
  useLive(live);
  const connected = engine.connected;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const active = engine.activeCount();
  const pending = engine.tasks.filter((t) => t.status === 'awaiting_approval');
  const s = engine.settings;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="18" height="18">
            <path d="M10 2.5l7 4v7l-7 4-7-4v-7z" fill="#5fe0d2" opacity=".18" />
            <path d="M10 2.5l7 4-7 4-7-4z" fill="#5fe0d2" />
            <path d="M3 6.5v7l7 4v-7z" fill="#3aa79b" />
            <path d="M17 6.5v7l-7 4v-7z" fill="#2b7d74" />
          </svg>
        </span>
        <h1>WAD AI Office</h1>
      </div>
      <div className="seg mode-seg" role="radiogroup" aria-label="Mode">
        <button role="radio" aria-checked={!connected} className={!connected ? 'on' : ''} onClick={() => onSetMode('demo')}>
          Demo
        </button>
        <button role="radio" aria-checked={connected} className={connected ? 'on live' : ''} onClick={() => onSetMode('connected')}>
          Connected
        </button>
      </div>
      {connected ? (
        <span
          className={`demo-badge live-badge ${live.server === 'signed_in' ? '' : 'off'}`}
          title="Live data from WAD Furniture Management and WAD Order Management, read-only. Credentials stay on the server."
        >
          <i />
          {live.server === 'signed_in'
            ? compact
              ? 'Live · read-only'
              : `Connected Mode — Read-only · ${live.user?.username}`
            : compact
              ? 'Not signed in'
              : 'Connected Mode — Not signed in'}
        </span>
      ) : (
        <span className="demo-badge" title="All agents, data and responses are simulated. Nothing is connected to real accounts.">
          <i />
          {compact ? 'Demo' : 'Demo Mode — Simulated Agents'}
        </span>
      )}
      <div className="topbar-spacer" />
      {pending.length > 0 && (
        <button className="pill pill-warn" onClick={() => onOpenApproval(pending[0].id)}>
          <i className="pulse" />
          {pending.length} approval{pending.length > 1 ? 's' : ''}
        </button>
      )}
      <span className="pill" title="Agents currently working on a task">
        <i className={`dot ${active ? 'on' : ''}`} />
        <b>{active}</b>
        {compact ? '/8' : ' / 8 active'}
      </span>
      <button
        className={`icon-btn ${engine.paused ? 'is-on' : ''}`}
        onClick={() => engine.setPaused(!engine.paused)}
        aria-label={engine.paused ? 'Resume simulation' : 'Pause simulation'}
        title={connected ? (engine.paused ? 'Resume animations' : 'Pause animations (live reports keep running)') : engine.paused ? 'Resume simulation' : 'Pause simulation'}
      >
        {engine.paused ? <IconPlay /> : <IconPause />}
      </button>
      <button
        className="icon-btn"
        onClick={() => engine.updateSettings({ sound: !s.sound })}
        aria-label={s.sound ? 'Turn sound off' : 'Turn sound on'}
        title={s.sound ? 'Sound on' : 'Sound off'}
      >
        {s.sound ? <IconSound /> : <IconMute />}
      </button>
      <div className="settings-anchor">
        <button
          className={`icon-btn ${settingsOpen ? 'is-on' : ''}`}
          onClick={() => setSettingsOpen((o) => !o)}
          aria-label="Settings"
          aria-expanded={settingsOpen}
          title="Settings"
        >
          <IconGear />
        </button>
        {settingsOpen && <SettingsMenu engine={engine} live={live} onClose={() => setSettingsOpen(false)} onResetView={onResetView} />}
      </div>
    </header>
  );
}

function SettingsMenu({ engine, live, onClose, onResetView }: { engine: Engine; live: LiveStore; onClose: () => void; onResetView: () => void }) {
  const s = engine.settings;
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.settings-anchor')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="menu" ref={ref} role="dialog" aria-label="Settings">
      <div className="menu-title">Settings</div>
      <Toggle label="Sound effects" checked={s.sound} onChange={(v) => engine.updateSettings({ sound: v })} />
      <Toggle label="Reduced motion" checked={s.reducedMotion} onChange={(v) => engine.updateSettings({ reducedMotion: v })} />
      <Toggle label="Name labels" checked={s.labels} onChange={(v) => engine.updateSettings({ labels: v })} />
      <div className="menu-row">
        <span>Simulation speed</span>
        <div className="seg">
          {([1, 2] as const).map((v) => (
            <button key={v} className={s.speed === v ? 'on' : ''} onClick={() => engine.updateSettings({ speed: v })}>
              {v}×
            </button>
          ))}
        </div>
      </div>
      <div className="menu-sep" />
      <button
        className="menu-btn"
        onClick={() => {
          onResetView();
          onClose();
        }}
      >
        Reset view
      </button>
      {live.server === 'signed_in' && (
        <button
          className="menu-btn"
          onClick={() => {
            void live.logout();
            onClose();
          }}
        >
          Sign out of Connected Mode ({live.user?.username})
        </button>
      )}
      {!confirm ? (
        <button className="menu-btn danger" onClick={() => setConfirm(true)}>
          Reset demo…
        </button>
      ) : (
        <div className="confirm">
          <p>Clear all demo tasks, activity and counts? Live reports are not affected.</p>
          <div className="row">
            <button className="btn ghost sm" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="btn danger sm"
              onClick={() => {
                engine.resetDemo();
                setConfirm(false);
                onClose();
              }}
            >
              Reset demo
            </button>
          </div>
        </div>
      )}
      <p className="menu-foot">Settings and demo history are saved in this browser only. Live data is never stored in the browser.</p>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="menu-row toggle">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}
