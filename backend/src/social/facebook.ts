// Facebook Page posting (Graph API) for Carlo's posts. A person always approves each post in the
// office first; nothing here is called by the AI.
//
// - Talks only to graph.facebook.com, with the Page access token in a header (never in a URL or a
//   log line). With FACEBOOK_APP_SECRET set, every call also carries appsecret_proof.
// - Never retries a POST: a timeout could mean the post went through, so we report that instead of
//   risking a double post.
// - Scheduling uses Facebook's own scheduler (published=false + scheduled_publish_time), so a
//   scheduled post goes out even if this server is asleep or restarted. Photo posts are scheduled
//   the way Meta documents it: upload the photo as unpublished + temporary, then create the feed
//   post with attached_media and unpublished_content_type=SCHEDULED.
// - "Pending posts" are read back from the Page's scheduled_posts edge: Facebook is the record,
//   so posts scheduled in Meta Business Suite show up too, and nothing is stored here.

import { createHmac } from 'node:crypto';
import type { ScheduledPost } from '../../shared/live';

export const GRAPH_HOST = 'graph.facebook.com';

export type FacebookErrorCode = 'NOT_CONFIGURED' | 'AUTH_FAILED' | 'PERMISSION_DENIED' | 'RATE_LIMITED' | 'INVALID' | 'TIMEOUT' | 'NETWORK' | 'UPSTREAM_ERROR';

export class FacebookError extends Error {
  constructor(
    public code: FacebookErrorCode,
    message: string,
    public httpStatus = 502,
  ) {
    super(message);
  }
}

export interface FacebookOptions {
  pageId: string;
  token: string;
  appSecret?: string | null;
  version: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface PostRequest {
  message: string;
  image?: { mimeType: string; data: string };
  /** Unix seconds; omitted = publish now. */
  at?: number;
}

export interface PostResult {
  postId: string;
  link: string | null;
  scheduledAt: string | null;
}

export class FacebookClient {
  private fetchImpl: typeof fetch;
  private nameCache: { name: string | null; until: number } | null = null;

  constructor(private o: FacebookOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  get pageId() {
    return this.o.pageId;
  }

  /** The Page's name, for "Posting to …" (cached for 10 minutes; null if it can't be read). */
  async pageName(): Promise<string | null> {
    if (this.nameCache && this.nameCache.until > Date.now()) return this.nameCache.name;
    let name: string | null = null;
    try {
      const r = await this.call('GET', this.o.pageId, { query: { fields: 'name' } });
      name = typeof r.name === 'string' ? r.name : null;
    } catch {
      name = null;
    }
    this.nameCache = { name, until: Date.now() + 10 * 60_000 };
    return name;
  }

  async publish(req: PostRequest): Promise<PostResult> {
    const scheduled = req.at !== undefined;
    let postId: string;
    if (req.image && !scheduled) {
      // One call: the photo with its caption becomes the post.
      const form = this.photoForm(req.image);
      form.set('caption', req.message);
      form.set('published', 'true');
      const r = await this.call('POST', `${this.o.pageId}/photos`, { form });
      postId = String(r.post_id ?? r.id ?? '');
    } else {
      const form = new FormData();
      form.set('message', req.message);
      if (req.image) {
        // Scheduled photo post: upload the photo unpublished + temporary, then attach it.
        const up = this.photoForm(req.image);
        up.set('published', 'false');
        up.set('temporary', 'true');
        const photo = await this.call('POST', `${this.o.pageId}/photos`, { form: up });
        if (!photo.id) throw new FacebookError('UPSTREAM_ERROR', 'Facebook did not return an ID for the uploaded photo.');
        form.set('attached_media[0]', JSON.stringify({ media_fbid: String(photo.id) }));
      }
      if (scheduled) {
        form.set('published', 'false');
        form.set('scheduled_publish_time', String(req.at));
        form.set('unpublished_content_type', 'SCHEDULED');
      }
      const r = await this.call('POST', `${this.o.pageId}/feed`, { form });
      postId = String(r.id ?? '');
    }
    if (!postId) throw new FacebookError('UPSTREAM_ERROR', 'Facebook accepted the request but returned no post ID. Check the Page before trying again.');
    let link: string | null = null;
    try {
      const r = await this.call('GET', postId, { query: { fields: 'permalink_url' } });
      link = typeof r.permalink_url === 'string' && r.permalink_url.startsWith('https://') ? r.permalink_url : null;
    } catch {
      link = null; // the post exists; the link is a nice-to-have
    }
    return { postId, link, scheduledAt: scheduled ? new Date(req.at! * 1000).toISOString() : null };
  }

  /** Posts waiting in the Page's schedule, soonest first. */
  async scheduled(): Promise<ScheduledPost[]> {
    const r = await this.call('GET', `${this.o.pageId}/scheduled_posts`, {
      query: { fields: 'id,message,scheduled_publish_time,full_picture,permalink_url', limit: '50' },
    });
    const list = Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : [];
    return list
      .map((p) => {
        const t = p.scheduled_publish_time;
        const secs = typeof t === 'number' ? t : typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : typeof t === 'string' ? Date.parse(t) / 1000 : NaN;
        return {
          id: String(p.id ?? ''),
          message: typeof p.message === 'string' ? p.message.slice(0, 2000) : '',
          scheduledAt: Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : null,
          hasPicture: typeof p.full_picture === 'string' && p.full_picture.length > 0,
          link: typeof p.permalink_url === 'string' && p.permalink_url.startsWith('https://') ? p.permalink_url : null,
        };
      })
      .filter((p) => p.id)
      .sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
  }

  /** Deletes one of this Page's posts (used to cancel a scheduled post). */
  async cancel(postId: string): Promise<void> {
    if (!new RegExp(`^${this.o.pageId}_\\d+$`).test(postId)) throw new FacebookError('INVALID', 'That is not a post on this Page.', 400);
    await this.call('DELETE', postId, {});
  }

  private photoForm(image: { mimeType: string; data: string }) {
    const form = new FormData();
    const ext = image.mimeType === 'image/png' ? 'png' : image.mimeType === 'image/webp' ? 'webp' : 'jpg';
    form.set('source', new Blob([Buffer.from(image.data, 'base64')], { type: image.mimeType }), `wad-photo.${ext}`);
    return form;
  }

  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, opts: { query?: Record<string, string>; form?: FormData }): Promise<Record<string, unknown>> {
    const url = new URL(`https://${GRAPH_HOST}/${this.o.version}/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    if (this.o.appSecret) url.searchParams.set('appsecret_proof', createHmac('sha256', this.o.appSecret).update(this.o.token).digest('hex'));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs);
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${this.o.token}`, Accept: 'application/json' },
        body: opts.form,
        redirect: 'manual',
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const timedOut = (e as Error)?.name === 'AbortError';
      this.logLine(method, url, timedOut ? 'timeout' : 'network-error', started);
      if (timedOut)
        throw new FacebookError(
          'TIMEOUT',
          method === 'POST'
            ? 'Facebook did not answer in time. The post may or may not have gone through: check the Page before trying again.'
            : 'Facebook did not answer in time.',
          504,
        );
      throw new FacebookError('NETWORK', 'Could not reach Facebook.', 502);
    }
    clearTimeout(timer);
    this.logLine(method, url, String(res.status), started);
    const text = await res.text().catch(() => '');
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (res.ok && !body.error) return body;
    throw toFacebookError(res.status, body.error as Record<string, unknown> | undefined);
  }

  private logLine(method: string, url: URL, outcome: string, started: number) {
    // Host and path only: no query string (appsecret_proof) and never the token.
    this.o.log?.(`[facebook] ${method} ${url.host}${url.pathname} -> ${outcome} (${Date.now() - started} ms)`);
  }
}

/** Turns a Graph API error into a clear message. Facebook's own text is shortened, never echoed in full. */
function toFacebookError(status: number, err: Record<string, unknown> | undefined): FacebookError {
  const code = Number(err?.code);
  const fbMsg = typeof err?.message === 'string' ? err.message.replace(/\s+/g, ' ').slice(0, 200) : '';
  if (code === 190) return new FacebookError('AUTH_FAILED', 'Facebook rejected the Page token (expired or revoked). Create a new Page access token and update FACEBOOK_PAGE_TOKEN.', 502);
  if (code === 10 || (code >= 200 && code < 300) || code === 283)
    return new FacebookError('PERMISSION_DENIED', `The Page token is missing a permission (it needs pages_manage_posts and pages_read_engagement).${fbMsg ? ` Facebook said: ${fbMsg}` : ''}`, 502);
  if ([4, 17, 32, 613].includes(code)) return new FacebookError('RATE_LIMITED', 'Facebook is limiting requests right now. Try again in a few minutes.', 429);
  if (code === 368) return new FacebookError('PERMISSION_DENIED', `Facebook temporarily blocked posting from this Page.${fbMsg ? ` Facebook said: ${fbMsg}` : ''}`, 502);
  if (code === 100 || status === 400) return new FacebookError('INVALID', `Facebook did not accept the post.${fbMsg ? ` Facebook said: ${fbMsg}` : ''}`, 400);
  return new FacebookError('UPSTREAM_ERROR', `Facebook returned HTTP ${status}.${fbMsg ? ` ${fbMsg}` : ''}`, 502);
}
