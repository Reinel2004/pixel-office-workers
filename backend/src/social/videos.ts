// Video uploads for Facebook posts. The browser sends the video in pieces (VIDEO_CHUNK_BYTES),
// which works behind proxies with request size limits and never holds a large video in memory;
// the pieces go into one temporary file, which is then uploaded to Facebook in its own pieces and
// deleted. Nothing about the video is kept after that, and it never goes to the AI provider
// (Carlo only ever sees still frames the browser took from it).
//
// Safety:
//  - Only accounts with social:post, only their own uploads (an upload id is useless to anyone else).
//  - Type (MP4/MOV), declared size (at most FB_VIDEO_MAX_BYTES) and the file's real signature are
//    checked; each piece must arrive at the expected offset and may not run past the declared size.
//  - An upload posts at most once: its state goes received -> posting -> posted, so a repeated
//    click or a resent request cannot make a second post.
//  - Unused uploads are deleted after 2 hours; at most 2 per account at a time.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoUploadStatus } from '../../shared/live';
import { FB_VIDEO_MAX_BYTES, VIDEO_CHUNK_BYTES, VIDEO_TYPES } from '../../shared/live';
import { FacebookError, type FacebookClient, type PostResult } from './facebook';

export class VideoUploadError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Upload extends VideoUploadStatus {
  owner: string;
  mimeType: string;
  path: string;
  createdAt: number;
}

const TTL_MS = 2 * 3600_000;
const PER_USER = 2;

export class VideoUploads {
  private items = new Map<string, Upload>();
  private dir: string;
  private timer: ReturnType<typeof setInterval>;

  constructor(private o: { dir?: string; log?: (line: string) => void; now?: () => number } = {}) {
    this.dir = o.dir ?? join(tmpdir(), 'wad-ai-office-videos');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // Leftovers from before a restart are useless (their uploads are forgotten): delete them.
    for (const f of readdirSync(this.dir)) {
      try {
        if (/^[0-9a-f-]{36}\.(mp4|mov)$/.test(f) && statSync(join(this.dir, f)).isFile()) rmSync(join(this.dir, f), { force: true });
      } catch {
        /* ignore */
      }
    }
    this.timer = setInterval(() => this.sweep(), 10 * 60_000);
    this.timer.unref?.();
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  private view(u: Upload): VideoUploadStatus {
    return { id: u.id, state: u.state, bytes: u.bytes, received: u.received, sentToFacebook: u.sentToFacebook, post: u.post, error: u.error };
  }

  private mine(user: string, id: string): Upload {
    const u = this.items.get(id);
    if (!u || u.owner !== user) throw new VideoUploadError(404, 'Upload not found (it may have expired). Choose the video again.');
    return u;
  }

  /** Deletes expired uploads and their files (never one that is being posted). */
  sweep() {
    const cutoff = this.now() - TTL_MS;
    for (const u of this.items.values()) if (u.createdAt < cutoff && u.state !== 'posting') this.drop(u);
  }

  private drop(u: Upload) {
    this.items.delete(u.id);
    void rm(u.path, { force: true }).catch(() => undefined);
  }

  close() {
    clearInterval(this.timer);
  }

  /** Starts an upload: the browser says how big the video is and its type. */
  create(user: string, bytes: unknown, mimeType: unknown): VideoUploadStatus {
    if (typeof mimeType !== 'string' || !(VIDEO_TYPES as readonly string[]).includes(mimeType)) throw new VideoUploadError(400, 'Use an MP4 or MOV video.');
    const n = Number(bytes);
    if (!Number.isInteger(n) || n <= 0) throw new VideoUploadError(400, 'The video size is missing.');
    if (n > FB_VIDEO_MAX_BYTES) throw new VideoUploadError(413, `The video is too large (max ${Math.round(FB_VIDEO_MAX_BYTES / 1024 / 1024)} MB). Trim or compress it first.`);
    // Make room: the account's oldest unfinished upload goes (never one being posted).
    const own = [...this.items.values()].filter((u) => u.owner === user && u.state !== 'posting' && u.state !== 'posted').sort((a, b) => a.createdAt - b.createdAt);
    while (own.length >= PER_USER) this.drop(own.shift()!);
    const id = randomUUID();
    const u: Upload = {
      id,
      owner: user,
      mimeType,
      path: join(this.dir, `${id}.${mimeType === 'video/quicktime' ? 'mov' : 'mp4'}`),
      createdAt: this.now(),
      state: 'receiving',
      bytes: n,
      received: 0,
      sentToFacebook: 0,
      post: null,
      error: null,
    };
    this.items.set(id, u);
    return this.view(u);
  }

  /** Adds the next piece. It must start where the previous one ended. */
  async append(user: string, id: string, offset: number, chunk: Buffer): Promise<VideoUploadStatus> {
    const u = this.mine(user, id);
    if (u.state !== 'receiving') throw new VideoUploadError(409, 'This video has already been received.');
    if (offset !== u.received) throw new VideoUploadError(409, `Expected the part starting at byte ${u.received}.`);
    if (!chunk.length || chunk.length > VIDEO_CHUNK_BYTES) throw new VideoUploadError(400, 'That part of the video has the wrong size.');
    if (u.received + chunk.length > u.bytes) throw new VideoUploadError(400, 'The video is bigger than its declared size.');
    if (offset === 0 && !looksLikeVideo(chunk)) {
      this.drop(u);
      throw new VideoUploadError(400, 'That file is not a valid MP4 or MOV video.');
    }
    await appendFile(u.path, chunk, { mode: 0o600 });
    u.received += chunk.length;
    if (u.received === u.bytes) u.state = 'received';
    return this.view(u);
  }

  status(user: string, id: string): VideoUploadStatus {
    return this.view(this.mine(user, id));
  }

  /** Discards an upload that has not been posted. */
  discard(user: string, id: string) {
    const u = this.mine(user, id);
    if (u.state === 'posting') throw new VideoUploadError(409, 'This video is being posted right now.');
    this.drop(u);
  }

  /**
   * Starts posting a received video (in the background: a large video can take minutes; the
   * browser polls the status). An upload is posted at most once.
   */
  post(
    user: string,
    id: string,
    req: { message: string; at?: number },
    fb: FacebookClient,
    hooks: { done?: (r: PostResult) => void; failed?: (e: unknown) => void } = {},
  ): VideoUploadStatus {
    const u = this.mine(user, id);
    if (u.state === 'posting' || u.state === 'posted') return this.view(u); // already on its way: never twice
    if (u.state !== 'received') throw new VideoUploadError(409, 'The video has not finished uploading yet.');
    if (!existsSync(u.path)) throw new VideoUploadError(410, 'The uploaded video is gone (the server restarted?). Choose it again.');
    u.state = 'posting';
    u.error = null;
    u.sentToFacebook = 0;
    void fb
      .publishVideo({ path: u.path, bytes: u.bytes, mimeType: u.mimeType, message: req.message, at: req.at, onProgress: (n) => (u.sentToFacebook = n) })
      .then(async (r) => {
        await rm(u.path, { force: true }).catch(() => undefined);
        u.state = 'posted';
        u.post = r;
        u.sentToFacebook = u.bytes;
        hooks.done?.(r);
      })
      .catch((e: unknown) => {
        const msg = e instanceof FacebookError ? e.message : 'Posting the video failed.';
        if (e instanceof FacebookError && e.code === 'TIMEOUT') {
          // It may still have posted: never offer a retry from the same upload.
          u.state = 'failed';
          u.error = msg;
          void rm(u.path, { force: true }).catch(() => undefined);
        } else {
          // Nothing was posted: the file stays, so "try again" needs no new upload.
          u.state = 'received';
          u.error = `${msg} You can try again.`;
        }
        hooks.failed?.(e);
      });
    return this.view(u);
  }
}

/** MP4 and MOV files start with an atom: size (4 bytes) + type ("ftyp", or "moov"/"mdat"/"wide"/"free" in older MOVs). */
export function looksLikeVideo(head: Buffer): boolean {
  if (head.length < 12) return false;
  return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(head.subarray(4, 8).toString('latin1'));
}

/** Reads a raw request body into memory, refusing more than `limit` bytes. */
export async function readRaw(req: AsyncIterable<unknown>, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > limit) throw new VideoUploadError(413, 'That part of the video is too large.');
    parts.push(b);
  }
  return Buffer.concat(parts);
}
