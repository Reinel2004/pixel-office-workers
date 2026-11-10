// Minimal Gemini API client (generateContent with function calling).
// - Talks only to generativelanguage.googleapis.com; the API key goes in a header, never the URL.
// - Logs method, host, path (which names the model) and status only — never the key, prompts or data.
// - Each failure becomes an IntegrationError code the office already knows how to show.

import { IntegrationError } from '../http/errors';
import type { AiUsageMeter, UsageTag } from './usage';

export const GEMINI_HOST = 'generativelanguage.googleapis.com';

export type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { functionCall: { name: string; args?: Record<string, unknown>; id?: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } }
  | { inlineData: { mimeType: string; data: string } };

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: { type: 'object'; properties: Record<string, { type: string; description: string }>; required?: string[] };
}

export interface GenerateRequest {
  systemInstruction?: { parts: { text: string }[] };
  contents: GeminiContent[];
  tools?: { functionDeclarations: FunctionDeclaration[] }[];
  generationConfig?: { temperature?: number; maxOutputTokens?: number; responseMimeType?: 'application/json'; responseSchema?: Record<string, unknown> };
  /** mode NONE: the model must answer in text and may not ask for more data. */
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'NONE' } };
}

export interface GenerateResult {
  content: GeminiContent;
  finishReason: string | null;
  /** Token counts, when Gemini reports them. */
  usage?: { promptTokens: number; outputTokens: number; totalTokens: number } | null;
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Extra attempts after a 500/503 or network error. Default 0: one request per call, no hidden retries. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** AI usage tracker: checks the limits and counts every request (optional, e.g. in tests). */
  meter?: AiUsageMeter | null;
}

export class GeminiClient {
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  constructor(private opts: GeminiOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get model() {
    return this.opts.model;
  }

  /**
   * `signal` cancels the request (e.g. a cancelled team discussion); it then fails with code TIMEOUT.
   * `tag` says what the request is for, for the AI usage tracker (which may refuse it: AI_LIMIT).
   */
  async generate(body: GenerateRequest, opts: { signal?: AbortSignal; tag?: UsageTag; retries?: number } = {}): Promise<GenerateResult> {
    const url = new URL(`https://${GEMINI_HOST}/v1beta/models/${encodeURIComponent(this.opts.model)}:generateContent`);
    // `retries` (per call) overrides the client's default: extra attempts after a 500/503 or network error only.
    const maxRetries = Math.min(2, opts.retries ?? this.opts.maxRetries ?? 0);
    for (let attempt = 0; ; attempt++) {
      // Every attempt is a real request: the meter checks the limits and counts it first.
      const finish = this.opts.meter?.begin({ ...(opts.tag ?? { feature: 'other' }), model: this.opts.model });
      try {
        const result = await this.once(url, body, opts.signal);
        finish?.({ ok: true, usage: result.usage ?? null });
        return result;
      } catch (e) {
        const err = e instanceof IntegrationError ? e : new IntegrationError('INTERNAL', 'Unexpected error while calling Gemini.');
        const cancelled = !!opts.signal?.aborted;
        finish?.({ ok: false, code: cancelled ? 'CANCELLED' : err.code });
        const retry = !cancelled && attempt < maxRetries && (err.code === 'NETWORK' || (err.code === 'UPSTREAM_ERROR' && (err.httpStatus === 500 || err.httpStatus === 503)));
        if (!retry) throw err;
        // An overloaded model (503) usually needs a few seconds; wait a little longer each time.
        await this.sleep(err.code === 'NETWORK' ? 1000 : err.httpStatus === 503 ? 4000 * (attempt + 1) : 1500);
      }
    }
  }

  /** One HTTP request to Gemini; every failure becomes an IntegrationError. */
  private async once(url: URL, body: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    const onCancel = () => ctrl.abort();
    if (signal?.aborted) ctrl.abort();
    signal?.addEventListener('abort', onCancel, { once: true });
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
      if (signal?.aborted) throw new IntegrationError('TIMEOUT', 'The request was cancelled.');
      const timedOut = (e as Error)?.name === 'AbortError';
      this.logLine(url, timedOut ? 'timeout' : 'network-error', started);
      throw timedOut
        ? new IntegrationError('TIMEOUT', `Gemini did not answer within ${Math.round(this.opts.timeoutMs / 1000)} seconds.`)
        : new IntegrationError('NETWORK', 'Could not reach Gemini.');
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCancel);
    this.logLine(url, String(res.status), started);
    const text = await res.text().catch(() => '');
    if (signal?.aborted) throw new IntegrationError('TIMEOUT', 'The request was cancelled.');
    if (res.ok) return parse(text);

    const reason = errorReason(text);
    if (res.status === 429)
      throw new IntegrationError(
        'RATE_LIMITED',
        `Gemini's usage limit was reached (the free tier allows only a small number of requests per minute and per day). Try again later, or use a paid key.`,
        undefined,
        429,
      );
    if (res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(reason))
      throw new IntegrationError('AUTH_FAILED', 'Gemini rejected the API key (GEMINI_API_KEY is invalid or was revoked).', undefined, 400);
    if (res.status === 401 || res.status === 403)
      throw new IntegrationError('AUTH_FAILED', 'Gemini refused the API key for this model or project.', undefined, res.status);
    if (res.status === 404)
      throw new IntegrationError('NOT_CONFIGURED', `Gemini has no model named "${this.opts.model}" for this key. Set GEMINI_MODEL in .env (run "npm run gemini-models" to list them).`, undefined, 404);
    if (res.status === 503)
      throw new IntegrationError(
        'UPSTREAM_ERROR',
        `Gemini is overloaded right now (Google's servers are busy, HTTP 503). This is temporary and not a problem in the office: try again in a minute. If it keeps happening, set GEMINI_MODEL to another model.`,
        undefined,
        503,
      );
    throw new IntegrationError('UPSTREAM_ERROR', `Gemini returned HTTP ${res.status}${reason ? `: ${reason.slice(0, 160)}` : ''}.`, undefined, res.status);
  }

  private logLine(url: URL, outcome: string, started: number) {
    this.opts.log?.(`[ai] POST ${url.host}${url.pathname} -> ${outcome} (${Date.now() - started}ms)`);
  }
}

function errorReason(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; status?: string; details?: { reason?: string }[] } };
    return [j.error?.details?.find((d) => d.reason)?.reason, j.error?.message].filter(Boolean).join(' — ');
  } catch {
    return '';
  }
}

function parse(text: string): GenerateResult {
  let j: {
    candidates?: { content?: GeminiContent; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; thoughtsTokenCount?: number };
  };
  try {
    j = JSON.parse(text);
  } catch {
    throw new IntegrationError('INVALID_RESPONSE', 'Gemini returned a response that is not valid JSON.');
  }
  if (j.promptFeedback?.blockReason) throw new IntegrationError('UPSTREAM_ERROR', `Gemini declined this request (${j.promptFeedback.blockReason}).`);
  const c = j.candidates?.[0];
  if (!c) throw new IntegrationError('INVALID_RESPONSE', 'Gemini returned no answer.');
  if (c.finishReason === 'SAFETY' || c.finishReason === 'PROHIBITED_CONTENT' || c.finishReason === 'BLOCKLIST')
    throw new IntegrationError('UPSTREAM_ERROR', `Gemini stopped the answer (${c.finishReason}).`);
  const content: GeminiContent = { role: 'model', parts: Array.isArray(c.content?.parts) ? c.content!.parts : [] };
  const u = j.usageMetadata;
  const usage =
    u && typeof u.totalTokenCount === 'number'
      ? { promptTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), totalTokens: u.totalTokenCount }
      : null;
  return { content, finishReason: c.finishReason ?? null, usage };
}
