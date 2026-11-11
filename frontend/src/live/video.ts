// Videos for Carlo and Facebook, in the browser:
//  - prepareVideo() checks the file (MP4/MOV, size) and takes a few still frames from it with a
//    <video> element and a canvas. Only those small JPEG frames are sent with Carlo's task, so the
//    AI sees the video without the whole file going to the server or to Google.
//  - The file itself stays in this tab's memory (an object URL) until a person approves the post;
//    then it is uploaded to the office server in pieces and passed on to Facebook. Nothing is saved;
//    after a reload the video is gone.

import { FB_VIDEO_MAX_BYTES, MAX_FRAME_BYTES, MAX_VIDEO_FRAMES, VIDEO_TYPES } from '../../shared/live';

export interface VideoPick {
  file: File;
  /** MP4 or MOV type (worked out from the file name when the browser does not say). */
  mimeType: (typeof VIDEO_TYPES)[number];
  /** Object URL for previews (this tab only). */
  url: string;
  durationSec: number;
  /** JPEG data URLs, evenly spaced through the video. */
  frames: string[];
  /** The server-side upload, once started (lets "try again" skip a second upload). */
  uploadId?: string;
}

const MB = 1024 * 1024;

export function isVideoFile(f: File) {
  return f.type.startsWith('video/') || /\.(mp4|m4v|mov)$/i.test(f.name);
}

function typeOf(f: File): VideoPick['mimeType'] | null {
  if ((VIDEO_TYPES as readonly string[]).includes(f.type)) return f.type as VideoPick['mimeType'];
  if (/\.(mp4|m4v)$/i.test(f.name)) return 'video/mp4';
  if (/\.mov$/i.test(f.name)) return 'video/quicktime';
  return null;
}

const UNREADABLE = "This browser can't open that video, so Carlo can't see it. It may use a format such as HEVC: export or convert it to MP4 (H.264) and try again.";

function once(el: HTMLVideoElement, event: string, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => (cleanup(), reject(new Error(UNREADABLE))), ms);
    const ok = () => (cleanup(), resolve());
    const bad = () => (cleanup(), reject(new Error(UNREADABLE)));
    const cleanup = () => {
      clearTimeout(t);
      el.removeEventListener(event, ok);
      el.removeEventListener('error', bad);
    };
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

/** Checks a video and takes up to MAX_VIDEO_FRAMES still frames from it. */
export async function prepareVideo(file: File): Promise<VideoPick> {
  const mimeType = typeOf(file);
  if (!mimeType) throw new Error('Choose an MP4 or MOV video.');
  if (file.size > FB_VIDEO_MAX_BYTES) throw new Error(`That video is ${Math.round(file.size / MB)} MB; the limit is ${Math.round(FB_VIDEO_MAX_BYTES / MB)} MB. Trim or compress it first.`);
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try {
    const meta = once(v, 'loadeddata', 20_000);
    v.src = url;
    await meta;
    const d = v.duration;
    if (!Number.isFinite(d) || d <= 0) throw new Error(UNREADABLE);
    const n = d < 2 ? Math.min(3, MAX_VIDEO_FRAMES) : MAX_VIDEO_FRAMES;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) throw new Error(UNREADABLE);
    const scale = Math.min(1, 768 / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot prepare the video.');
    const frames: string[] = [];
    for (let i = 0; i < n; i++) {
      // The same moments the server tells the AI about: the middle of each equal slice.
      const seeked = once(v, 'seeked', 10_000);
      v.currentTime = Math.min(d - 0.05, ((i + 0.5) / n) * d);
      await seeked;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      let q = 0.72;
      let data = canvas.toDataURL('image/jpeg', q);
      while ((data.length * 3) / 4 > MAX_FRAME_BYTES && q > 0.3) data = canvas.toDataURL('image/jpeg', (q -= 0.15));
      frames.push(data);
    }
    return { file, mimeType, url, durationSec: Math.round(d * 10) / 10, frames };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

export function formatDuration(sec: number) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
