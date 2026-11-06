// Minimal Gemini API client (generateContent with function calling).
// - Talks only to generativelanguage.googleapis.com; the API key goes in a header, never the URL.
// - Logs method, host, path (which names the model) and status only — never the key, prompts or data.
// - Each failure becomes an IntegrationError code the office already knows how to show.

import { IntegrationError } from '../http/errors';

export const GEMINI_HOST = 'generativelanguage.googleapis.com';

export type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { functionCall: { name: string; args?: Record<string, unknown>; id?: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };

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
  generationConfig?: { temperature?: number; maxOutputTokens?: number };
  /** mode NONE: the model must answer in text and may not ask for more data. */
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'NONE' } };
}

export interface GenerateResult {
  content: GeminiContent;
  finishReason: string | null;
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

  async generate(body: GenerateRequest): Promise<GenerateResult> {
    const url = new URL(`https://${GEMINI_HOST}/v1beta/models/${encodeURIComponent(this.opts.model)}:generateContent`);
    const maxRetries = this.opts.maxRetries ?? 0;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
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
        const timedOut = (e as Error)?.name === 'AbortError';
        this.logLine(url, timedOut ? 'timeout' : 'network-error', started);
        if (attempt < maxRetries && !timedOut) {
          await this.sleep(1000);
          continue;
        }
        throw timedOut
          ? new IntegrationError('TIMEOUT', `Gemini did not answer within ${Math.round(this.opts.timeoutMs / 1000)} seconds.`)
          : new IntegrationError('NETWORK', 'Could not reach Gemini.');
      }
      clearTimeout(timer);
      this.logLine(url, String(res.status), started);
      const text = await res.text().catch(() => '');
      if (res.ok) return parse(text);

      const reason = errorReason(text);
      if ((res.status === 500 || res.status === 503) && attempt < maxRetries) {
        await this.sleep(1500);
        continue;
      }
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
      throw new IntegrationError('UPSTREAM_ERROR', `Gemini returned HTTP ${res.status}${reason ? `: ${reason.slice(0, 160)}` : ''}.`, undefined, res.status);
    }
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
  return { content, finishReason: c.finishReason ?? null };
}
