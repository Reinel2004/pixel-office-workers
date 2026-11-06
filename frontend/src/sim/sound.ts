// Tiny synthesized sound cues (no audio files). Only plays when the sound setting is on.

let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const C = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return null;
  if (!ctx) ctx = new C();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'triangle', vol = 0.06) {
  const c = ac();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t0 = c.currentTime + start;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

export function playCue(cue: 'approval' | 'complete' | 'error' | 'blip' | 'click') {
  try {
    switch (cue) {
      case 'approval':
        tone(660, 0, 0.18);
        tone(880, 0.16, 0.25);
        break;
      case 'complete':
        tone(523, 0, 0.12);
        tone(659, 0.1, 0.12);
        tone(784, 0.2, 0.22);
        break;
      case 'error':
        tone(220, 0, 0.25, 'square', 0.04);
        tone(180, 0.18, 0.3, 'square', 0.04);
        break;
      case 'blip':
        tone(990, 0, 0.08, 'sine', 0.04);
        break;
      case 'click':
        tone(700, 0, 0.05, 'sine', 0.03);
        break;
    }
  } catch {
    /* audio not available */
  }
}
