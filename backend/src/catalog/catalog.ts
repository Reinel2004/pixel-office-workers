// The online catalog (Kat): adds an approved product to the catalog website's GitHub repository.
//
// The catalog is a static site: products.js holds the product list and assets/ the photos. The
// site's host (Vercel) rebuilds it whenever the repository's branch changes. So adding a product
// = one commit with the photo and the updated products.js:
//   1. read the branch's latest commit and products.js at that commit
//   2. work out the next free product id and an unused file name for the photo
//   3. upload the photo (a blob), write the tree with both files, make the commit
//   4. move the branch to the new commit (never forced: if someone changed the branch meanwhile,
//      start again once from step 1 so their change is kept)
//
// Safety:
// - Talks only to api.github.com, with the token in a header (never in a URL or a log line). The
//   token should be a fine-grained token limited to the catalog repository ("Contents: read and write").
// - Only ADDS a product: existing products are never edited or removed.
// - Every text field is plain text: characters that could break the page's HTML or the JavaScript
//   file (< > " ` \ and control characters) are removed, and quotes are escaped.
// - The products.js file is never run here; it is edited as text, and checked before and after.
// - A person approves every product in the office; the AI never calls this.

import type { CatalogAddResult, CatalogCategory, CatalogDoorType, CatalogProductInput } from '../../shared/live';
import { CATALOG_CATEGORIES, CATALOG_DOOR_TYPES, CATALOG_LIMITS, CATALOG_MAX_IMAGE_BYTES } from '../../shared/live';

export const GITHUB_HOST = 'api.github.com';
export const PRODUCTS_FILE = 'products.js';

/** Photo folder for each category (used when the catalog has no product in that category yet). */
const DEFAULT_FOLDERS: Record<CatalogCategory, string> = { Doors: 'doors', Cabinets: 'cabinet', 'Dining Tables': 'dining', 'Bed Frames': 'bedframe' };

export type CatalogErrorCode = 'NOT_CONFIGURED' | 'INVALID' | 'AUTH_FAILED' | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMITED' | 'FILE_CHANGED' | 'TIMEOUT' | 'NETWORK' | 'UPSTREAM_ERROR';

export class CatalogError extends Error {
  constructor(
    public code: CatalogErrorCode,
    message: string,
    public httpStatus = 502,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- product fields

/** Plain text only: removes what could break the page (HTML) or products.js (JavaScript). */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[<>"`\\]/g, '')
    .replace(/\$\{/g, '$ {')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** Checks a product a person approved; throws CatalogError(INVALID) with a message for the person. */
export function checkProduct(raw: unknown): CatalogProductInput {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (typeof p !== 'object' || Array.isArray(p)) throw new CatalogError('INVALID', 'The product could not be read.', 400);
  const category = CATALOG_CATEGORIES.find((c) => c === p.category);
  if (!category) throw new CatalogError('INVALID', `Choose a category: ${CATALOG_CATEGORIES.join(', ')}.`, 400);
  let doorType: CatalogDoorType | null = null;
  if (category === 'Doors') {
    doorType = CATALOG_DOOR_TYPES.find((t) => t === p.doorType) ?? null;
    if (!doorType) throw new CatalogError('INVALID', `Choose a door type: ${CATALOG_DOOR_TYPES.join(', ')}.`, 400);
  }
  const name = cleanText(p.name, CATALOG_LIMITS.name);
  if (name.length < 3) throw new CatalogError('INVALID', 'Give the product a name.', 400);
  const material = cleanText(p.material, CATALOG_LIMITS.material);
  if (!material) throw new CatalogError('INVALID', 'Fill in the material.', 400);
  const description = cleanText(p.description, CATALOG_LIMITS.description);
  if (description.length < 5) throw new CatalogError('INVALID', 'Write a short description.', 400);
  const rawFinishes = Array.isArray(p.finishes) ? p.finishes : typeof p.finishes === 'string' ? p.finishes.split(',') : [];
  const finishes = [...new Set(rawFinishes.map((f) => cleanText(f, CATALOG_LIMITS.finish)).filter(Boolean))];
  if (finishes.length > CATALOG_LIMITS.finishes) throw new CatalogError('INVALID', `List at most ${CATALOG_LIMITS.finishes} finishes.`, 400);
  return { category, doorType, name, material, dimensions: cleanText(p.dimensions, CATALOG_LIMITS.dimensions), finishes, description };
}

/** The photo: a JPEG, PNG or WebP of at most CATALOG_MAX_IMAGE_BYTES (checked by its first bytes). */
export function checkCatalogImage(raw: unknown): { ext: 'jpg' | 'png' | 'webp'; data: string; bytes: number } {
  const img = raw as { mimeType?: unknown; data?: unknown } | null;
  if (!img || typeof img !== 'object' || typeof img.mimeType !== 'string' || typeof img.data !== 'string') throw new CatalogError('INVALID', 'Add the product photo.', 400);
  const data = img.data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new CatalogError('INVALID', 'The photo could not be read.', 400);
  const buf = Buffer.from(data, 'base64');
  if (buf.length > CATALOG_MAX_IMAGE_BYTES) throw new CatalogError('INVALID', `The photo is too large for the catalog (max ${Math.round(CATALOG_MAX_IMAGE_BYTES / 1024)} KB).`, 413);
  const ext =
    img.mimeType === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
      ? 'jpg'
      : img.mimeType === 'image/png' && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        ? 'png'
        : img.mimeType === 'image/webp' && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
          ? 'webp'
          : null;
  if (!ext) throw new CatalogError('INVALID', 'That file is not a valid JPEG, PNG or WebP photo.', 400);
  return { ext, data, bytes: buf.length };
}

// ---------------------------------------------------------------- products.js (edited as text)

const OPEN = /const\s+products\s*=\s*\[/;
const CLOSE = /\r?\n\];\s*$/;

/** The shape the office expects; anything else is refused instead of guessed at. */
export function checkProductsFile(text: string) {
  if (!OPEN.test(text) || !CLOSE.test(text)) throw new CatalogError('FILE_CHANGED', `${PRODUCTS_FILE} no longer looks like "const products = [ … ];", so the office will not change it. Check the file in the catalog repository.`, 409);
}

/** Every id in the file, including commented-out products (so an id is never reused). */
export function nextProductId(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/\bid:\s*(\d{1,9})\b/g)) max = Math.max(max, Number(m[1]));
  return max + 1;
}

/** Products shown on the site now (commented-out ones are left out). */
export function countProducts(text: string): number {
  return text.split(/\r?\n/).filter((l) => /^\s*id:\s*\d+/.test(l)).length;
}

/** The photo folder this category already uses most, e.g. "doors" for Doors. */
export function folderFor(text: string, category: CatalogCategory): string {
  const counts = new Map<string, number>();
  const re = /category:\s*'([^']+)'[\s\S]*?image:\s*'\.\/assets\/([\w-]+)\//g;
  for (const m of text.matchAll(re)) if (m[1] === category) counts.set(m[2], (counts.get(m[2]) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : DEFAULT_FOLDERS[category];
}

const js = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The new product, written like the products already in the file. */
export function renderProduct(id: number, p: CatalogProductInput, imagePath: string, eol: string): string {
  const head = [`id: ${id}`, `category: ${js(p.category)}`, ...(p.doorType ? [`doorType: ${js(p.doorType)}`] : []), `name: ${js(p.name)}`].join(', ');
  return [
    '  {',
    `    ${head},`,
    `    material: ${js(p.material)}, dimensions: ${js(p.dimensions)},`,
    `    finishes: [${p.finishes.map(js).join(', ')}],`,
    `    description: ${js(p.description)},`,
    `    image: ${js(`./${imagePath}`)},`,
    `    thumb: ${js(`./${imagePath}`)},`,
    '  },',
  ].join(eol);
}

/** Adds the product at the end of the list, keeping the file's line endings. */
export function insertProduct(text: string, entry: string): string {
  checkProductsFile(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = text.match(CLOSE)!;
  let before = text.slice(0, m.index).replace(/\s+$/, '');
  if (before.endsWith('}')) before += ','; // the last product had no trailing comma
  return `${before}${eol}${eol}${entry}${eol}];${eol}`;
}

// ---------------------------------------------------------------- GitHub

export interface CatalogOptions {
  /** owner/name */
  repo: string;
  branch: string;
  /** Folder of the catalog site inside the repository ('' = the top level). */
  folder?: string;
  token: string;
  siteUrl: string | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
}

interface Snapshot {
  commitSha: string;
  treeSha: string;
  text: string;
}

export class CatalogClient {
  private fetch: typeof fetch;
  private countCache: { at: number; count: number } | null = null;
  constructor(private o: CatalogOptions) {
    this.fetch = o.fetchImpl ?? fetch;
  }

  get repo() {
    return this.o.repo;
  }
  get branch() {
    return this.o.branch;
  }
  get siteUrl() {
    return this.o.siteUrl;
  }
  get folder() {
    return this.o.folder ?? '';
  }

  /** A path inside the catalog site's folder, as a path in the repository. */
  private inRepo(path: string) {
    return this.folder ? `${this.folder}/${path}` : path;
  }

  /** products.js at a commit; a clear message when it is not where the settings say. */
  private async readProducts(ref: string): Promise<string> {
    let file: { content?: string; encoding?: string; type?: string };
    try {
      file = await this.call('GET', `contents/${encodeURI(this.inRepo(PRODUCTS_FILE))}?ref=${ref}`);
    } catch (e) {
      if (e instanceof CatalogError && e.code === 'NOT_FOUND')
        throw new CatalogError(
          'NOT_FOUND',
          `GitHub has no ${this.inRepo(PRODUCTS_FILE)} on branch ${this.o.branch} of ${this.o.repo}. If the catalog is in another folder of the repository, set CATALOG_GITHUB_FOLDER to that folder.`,
          502,
        );
      throw e;
    }
    if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string')
      throw new CatalogError('FILE_CHANGED', `${PRODUCTS_FILE} could not be read from the catalog repository.`, 409);
    const text = Buffer.from(file.content.replace(/\s+/g, ''), 'base64').toString('utf8');
    checkProductsFile(text);
    return text;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`https://${GITHUB_HOST}/repos/${this.o.repo}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.o.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'wad-ai-office',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new CatalogError('TIMEOUT', 'GitHub did not answer in time.', 504);
      throw new CatalogError('NETWORK', 'GitHub could not be reached.', 502);
    }
    if (res.ok) return (await res.json()) as T;
    let detail = '';
    try {
      detail = String(((await res.json()) as { message?: unknown }).message ?? '').slice(0, 200);
    } catch {
      /* no JSON body */
    }
    this.o.log?.(`[catalog] GitHub ${method} ${path.split('/')[0]}/${path.split('/')[1] ?? ''} -> ${res.status}`);
    const s = res.status;
    if (s === 401) throw new CatalogError('AUTH_FAILED', 'GitHub refused the token (CATALOG_GITHUB_TOKEN is wrong or expired).', 502);
    if (s === 403 && res.headers.get('x-ratelimit-remaining') === '0') throw new CatalogError('RATE_LIMITED', 'GitHub says there were too many requests. Try again in a few minutes.', 429);
    if (s === 403) throw new CatalogError('PERMISSION_DENIED', `The token cannot change ${this.o.repo}. Give it "Contents: read and write" on that repository.`, 502);
    if (s === 404) throw new CatalogError('NOT_FOUND', `GitHub cannot find ${this.o.repo} (branch ${this.o.branch}), or the token has no access to it.`, 502);
    if (s === 409 || s === 422) throw new CatalogError('CONFLICT', `GitHub refused the change${detail ? `: ${detail}` : ''}.`, 409);
    if (s === 429) throw new CatalogError('RATE_LIMITED', 'GitHub says there were too many requests. Try again in a few minutes.', 429);
    throw new CatalogError('UPSTREAM_ERROR', `GitHub returned HTTP ${s}.`, 502);
  }

  private async snapshot(): Promise<Snapshot> {
    const ref = await this.call<{ object: { sha: string } }>('GET', `git/ref/heads/${this.o.branch}`);
    const commit = await this.call<{ tree: { sha: string } }>('GET', `git/commits/${ref.object.sha}`);
    const text = await this.readProducts(ref.object.sha);
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha, text };
  }

  /** Products on the site now (cached for a minute; one GitHub read otherwise). */
  async productCount(): Promise<number> {
    const now = this.o.now?.() ?? Date.now();
    if (this.countCache && now - this.countCache.at < 60_000) return this.countCache.count;
    const ref = await this.call<{ object: { sha: string } }>('GET', `git/ref/heads/${this.o.branch}`);
    const text = await this.readProducts(ref.object.sha);
    const count = countProducts(text);
    this.countCache = { at: now, count };
    return count;
  }

  /** Adds one product (photo + entry) in one commit. At most 2 attempts if the branch moved meanwhile. */
  async add(product: CatalogProductInput, image: { ext: string; data: string }, by: string): Promise<CatalogAddResult> {
    const blob = await this.call<{ sha: string }>('POST', 'git/blobs', { content: image.data, encoding: 'base64' });
    for (let attempt = 1; ; attempt++) {
      const snap = await this.snapshot();
      const id = nextProductId(snap.text);
      const folder = folderFor(snap.text, product.category);
      const taken = new Set<string>();
      try {
        const list = await this.call<{ name: string }[]>('GET', `contents/${encodeURI(this.inRepo(`assets/${folder}`))}?ref=${snap.commitSha}`);
        if (Array.isArray(list)) for (const f of list) taken.add(f.name.toLowerCase());
      } catch (e) {
        if (!(e instanceof CatalogError && e.code === 'NOT_FOUND')) throw e; // a new folder is fine
      }
      let fileName = `wad-${id}.${image.ext}`;
      for (let n = 2; taken.has(fileName); n++) fileName = `wad-${id}-${n}.${image.ext}`;
      const imagePath = `assets/${folder}/${fileName}`;
      const eol = snap.text.includes('\r\n') ? '\r\n' : '\n';
      const text = insertProduct(snap.text, renderProduct(id, product, imagePath, eol));
      if (nextProductId(text) !== id + 1 || countProducts(text) !== countProducts(snap.text) + 1)
        throw new CatalogError('FILE_CHANGED', `The office could not add the product to ${PRODUCTS_FILE} safely; nothing was changed.`, 409);

      const tree = await this.call<{ sha: string }>('POST', 'git/trees', {
        base_tree: snap.treeSha,
        tree: [
          { path: this.inRepo(imagePath), mode: '100644', type: 'blob', sha: blob.sha },
          { path: this.inRepo(PRODUCTS_FILE), mode: '100644', type: 'blob', content: text },
        ],
      });
      const commit = await this.call<{ sha: string; html_url?: string }>('POST', 'git/commits', {
        message: `Add product ${id}: ${product.name}\n\nAdded from WAD AI Office (Kat) by ${by}.`,
        tree: tree.sha,
        parents: [snap.commitSha],
      });
      try {
        await this.call('PATCH', `git/refs/heads/${this.o.branch}`, { sha: commit.sha, force: false });
      } catch (e) {
        // Someone changed the branch since step 1: start again once from their version.
        if (e instanceof CatalogError && e.code === 'CONFLICT' && attempt < 2) continue;
        throw e;
      }
      this.countCache = null;
      return {
        productId: id,
        imagePath,
        commitSha: commit.sha,
        commitUrl: typeof commit.html_url === 'string' && commit.html_url.startsWith('https://github.com/') ? commit.html_url : null,
        siteUrl: this.o.siteUrl,
      };
    }
  }
}
