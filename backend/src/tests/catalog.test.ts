// The online catalog (Kat): product fields are plain text, products.js is edited as text (never
// run) and checked, the photo and the entry go to GitHub in ONE commit, the branch is never
// force-moved, one approval adds at most one product, and only allowed accounts can add.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { CatalogAddResult, CatalogProductInput, CatalogStatus } from '../../shared/live';
import type { FinanceSource, OrderSource } from '../adapters/types';
import { createApp } from '../app';
import { Auth, hashPassword } from '../auth';
import {
  CatalogClient,
  CatalogError,
  checkCatalogImage,
  checkProduct,
  cleanText,
  countProducts,
  folderFor,
  insertProduct,
  nextProductId,
  renderProduct,
} from '../catalog/catalog';
import { catalogConfig, loadConfig } from '../config';
import { checkImage, checkVideo, JobRunner } from '../jobs/runner';

const SAMPLE = [
  '// ─── PRODUCT DATA ───',
  'const products = [',
  '  {',
  "    id: 1, category: 'Doors', doorType: 'Main Door', name: 'Solid Kiln Dried Wood Door',",
  "    material: 'Solid Kiln Dried Wood', dimensions: '80-90 × 210cm',",
  "    finishes: ['Mahogany Wood', 'Varnished'],",
  "    description: 'Modern high quality kiln dried wood door.',",
  "    image: './assets/doors/door1.jpg',",
  "    thumb: './assets/doors/door1.jpg',",
  '  },',
  '  // {',
  "  //   id: 9, category: 'Doors', doorType: 'Main Door', name: 'Old door',",
  "  //   image: './assets/doors/door9.jpg',",
  '  // },',
  '  {',
  "    id: 7, category: 'Bed Frames', name: 'Bed Frame',",
  "    material: 'Solid Kiln Dried Wood', dimensions: '',",
  '    finishes: [],',
  "    description: 'A bed frame.',",
  "    image: './assets/bedframe/bedframe1.png',",
  "    thumb: './assets/bedframe/bedframe1.png',",
  '  }',
  '];',
].join('\r\n');

const run = (text: string) => new Function(`${text}\nreturn products;`)() as Record<string, unknown>[];
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]).toString('base64');
const DOOR: CatalogProductInput = {
  category: 'Doors',
  doorType: 'Main Door',
  name: "Kat's Carved Door",
  material: 'Solid Kiln Dried Wood',
  dimensions: '90 x 210cm',
  finishes: ['Varnished', 'Sand Beige'],
  description: 'A carved main door.',
};

test('product fields are plain text: HTML and script characters are removed, choices are checked', () => {
  assert.equal(cleanText('  <img src=x onerror="alert(1)">  Door\n\t`x` \\ ${y} ', 80), 'img src=x onerror=alert(1) Door x $ {y}');
  const p = checkProduct({ category: 'Doors', doorType: 'Flush Door', name: 'Flush <b>Door</b>', material: 'Wood', dimensions: '', finishes: 'Varnished, Varnished, Sand Beige', description: 'Smooth flush door.' });
  assert.equal(p.name, 'Flush bDoor/b');
  assert.deepEqual(p.finishes, ['Varnished', 'Sand Beige']);
  // Door type only for doors.
  assert.equal(checkProduct({ ...DOOR, category: 'Cabinets', doorType: 'Main Door' }).doorType, null);
  const bad = (v: unknown) => assert.throws(() => checkProduct(v), (e: CatalogError) => e instanceof CatalogError && e.code === 'INVALID');
  bad({ ...DOOR, category: 'Chairs' });
  bad({ ...DOOR, doorType: 'Garage Door' });
  bad({ ...DOOR, name: '' });
  bad({ ...DOOR, description: '' });
  bad({ ...DOOR, finishes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
  // The photo: real signature and size.
  assert.equal(checkCatalogImage({ mimeType: 'image/jpeg', data: JPEG }).ext, 'jpg');
  assert.throws(() => checkCatalogImage({ mimeType: 'image/png', data: JPEG }), /not a valid/);
  assert.throws(() => checkCatalogImage({ mimeType: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1100 * 1024)]).toString('base64') }), /too large/);
});

test('products.js: the new product is added at the end, in the same style, and the file still works', () => {
  assert.equal(nextProductId(SAMPLE), 10, 'commented-out ids are never reused');
  assert.equal(countProducts(SAMPLE), 2);
  assert.equal(folderFor(SAMPLE, 'Doors'), 'doors');
  assert.equal(folderFor(SAMPLE, 'Dining Tables'), 'dining', 'default folder for a category with no products');
  const out = insertProduct(SAMPLE, renderProduct(10, DOOR, 'assets/doors/wad-10.jpg', '\r\n'));
  assert.ok(!/[^\r]\n/.test(out), 'Windows line endings kept');
  assert.equal(countProducts(out), 3);
  const list = run(out);
  assert.equal(list.length, 3);
  assert.deepEqual(list[2], {
    id: 10,
    category: 'Doors',
    doorType: 'Main Door',
    name: "Kat's Carved Door",
    material: 'Solid Kiln Dried Wood',
    dimensions: '90 x 210cm',
    finishes: ['Varnished', 'Sand Beige'],
    description: 'A carved main door.',
    image: './assets/doors/wad-10.jpg',
    thumb: './assets/doors/wad-10.jpg',
  });
  assert.equal(list[1].id, 7, 'the last product (no trailing comma) is kept');
  // No door type line for other categories.
  assert.ok(!('doorType' in run(insertProduct(SAMPLE, renderProduct(10, { ...DOOR, category: 'Cabinets', doorType: null }, 'assets/cabinet/wad-10.jpg', '\r\n')))[2]));
  assert.throws(() => insertProduct('export default [];', 'x'), (e: CatalogError) => e.code === 'FILE_CHANGED');
});

/** A small fake of the GitHub API for one repository. */
function fakeGitHub(opts: { status?: number; moveOnce?: boolean; taken?: string[]; folder?: string } = {}) {
  const at = (p: string) => (opts.folder ? `${opts.folder}/${p}` : p);
  let n = 0;
  const sha = () => `sha${++n}`;
  const blobs = new Map<string, string>();
  const trees = new Map<string, Record<string, string>>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const t0 = sha();
  trees.set(t0, { [at('products.js')]: SAMPLE });
  const c0 = sha();
  commits.set(c0, { tree: t0, parents: [], message: 'init' });
  const state = { head: c0, patches: 0, posts: 0, auth: [] as string[] };
  let moved = false;
  const files = (commit: string) => trees.get(commits.get(commit)!.tree)!;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.github.com');
    state.auth.push(String((init?.headers as Record<string, string>).Authorization));
    if (opts.status) return json(opts.status, { message: 'nope' });
    const path = url.pathname.replace('/repos/WAD/catalog/', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (method !== 'GET') state.posts++;
    if (method === 'GET' && path === 'git/ref/heads/main') return json(200, { object: { sha: state.head } });
    if (method === 'GET' && path.startsWith('git/commits/')) return json(200, { tree: { sha: commits.get(path.slice(12))!.tree } });
    if (method === 'GET' && path === `contents/${at('products.js')}`)
      return json(200, { type: 'file', encoding: 'base64', content: Buffer.from(files(url.searchParams.get('ref')!)[at('products.js')]).toString('base64') });
    if (method === 'GET' && path.startsWith('contents/'))
      return path === `contents/${at('assets/doors')}` ? json(200, (opts.taken ?? []).map((name) => ({ name }))) : json(404, { message: 'Not Found' });
    if (method === 'POST' && path === 'git/blobs') {
      const s = sha();
      blobs.set(s, body.content);
      return json(201, { sha: s });
    }
    if (method === 'POST' && path === 'git/trees') {
      const base = { ...trees.get(body.base_tree)! };
      for (const e of body.tree) base[e.path] = e.content ?? `blob:${e.sha}`;
      const s = sha();
      trees.set(s, base);
      return json(201, { sha: s });
    }
    if (method === 'POST' && path === 'git/commits') {
      const s = sha();
      commits.set(s, { tree: body.tree, parents: body.parents, message: body.message });
      return json(201, { sha: s, html_url: `https://github.com/WAD/catalog/commit/${s}` });
    }
    if (method === 'PATCH' && path === 'git/refs/heads/main') {
      state.patches++;
      assert.equal(body.force, false);
      if (opts.moveOnce && !moved) {
        // Someone else added a product meanwhile: the branch moved, so this update is refused.
        moved = true;
        const t = sha();
        trees.set(t, { [at('products.js')]: insertProduct(SAMPLE, renderProduct(10, { ...DOOR, name: 'Someone else' }, 'assets/doors/x.jpg', '\r\n')) });
        const c = sha();
        commits.set(c, { tree: t, parents: [state.head], message: 'other' });
        state.head = c;
      }
      if (commits.get(body.sha)!.parents[0] !== state.head) return json(422, { message: 'Update is not a fast forward' });
      state.head = body.sha;
      return json(200, { object: { sha: body.sha } });
    }
    return json(404, { message: 'Not Found' });
  }) as typeof fetch;
  return { fetchImpl, state, files: () => files(state.head), blobs, commits };
}

const client = (fetchImpl: typeof fetch, folder = '') => new CatalogClient({ repo: 'WAD/catalog', branch: 'main', folder, token: 'github_pat_test_token_value', siteUrl: 'https://catalog.example', timeoutMs: 2000, fetchImpl });

test('GitHub: the photo and the product go in one commit; a taken file name is skipped', async () => {
  const gh = fakeGitHub({ taken: ['wad-10.jpg'] });
  const r = await client(gh.fetchImpl).add(DOOR, { ext: 'jpg', data: JPEG }, 'owner');
  assert.equal(r.productId, 10);
  assert.equal(r.imagePath, 'assets/doors/wad-10-2.jpg');
  assert.equal(r.commitUrl, `https://github.com/WAD/catalog/commit/${r.commitSha}`);
  assert.equal(gh.state.head, r.commitSha);
  assert.equal(gh.state.patches, 1);
  const f = gh.files();
  assert.ok(f['assets/doors/wad-10-2.jpg'].startsWith('blob:'));
  assert.equal(gh.blobs.get(f['assets/doors/wad-10-2.jpg'].slice(5)), JPEG);
  assert.equal(run(f['products.js'])[2].image, './assets/doors/wad-10-2.jpg');
  assert.match(gh.commits.get(r.commitSha)!.message, /Add product 10: Kat's Carved Door[\s\S]*by owner/);
  assert.ok(gh.state.auth.every((a) => a === 'Bearer github_pat_test_token_value'));
});

test('GitHub: a catalog in a folder of the repository (like WAD-CATALOG/) is read and changed there', async () => {
  const gh = fakeGitHub({ folder: 'WAD-CATALOG' });
  assert.equal(await client(gh.fetchImpl, 'WAD-CATALOG').productCount(), 2);
  const r = await client(gh.fetchImpl, 'WAD-CATALOG').add(DOOR, { ext: 'jpg', data: JPEG }, 'owner');
  const f = gh.files();
  assert.ok(f['WAD-CATALOG/assets/doors/wad-10.jpg'], 'the photo goes next to the other photos');
  assert.ok(!('products.js' in f) && !('assets/doors/wad-10.jpg' in f), 'nothing is added at the top level');
  assert.equal(run(f['WAD-CATALOG/products.js'])[2].image, './assets/doors/wad-10.jpg', 'the site path stays relative to the site');
  assert.equal(r.imagePath, 'assets/doors/wad-10.jpg');
  // Wrong folder: a clear message that names the setting.
  await assert.rejects(client(fakeGitHub().fetchImpl, 'WAD-CATALOG').productCount(), (e: CatalogError) => e.code === 'NOT_FOUND' && /WAD-CATALOG\/products\.js[\s\S]*CATALOG_GITHUB_FOLDER/.test(e.message));
});

test('GitHub: if the branch moved meanwhile, it starts again once and keeps the other change', async () => {
  const gh = fakeGitHub({ moveOnce: true });
  const r = await client(gh.fetchImpl).add(DOOR, { ext: 'jpg', data: JPEG }, 'owner');
  assert.equal(r.productId, 11, 'the next free id after the other change');
  const list = run(gh.files()['products.js']);
  assert.deepEqual(list.map((p) => p.name), ['Solid Kiln Dried Wood Door', 'Bed Frame', 'Someone else', "Kat's Carved Door"]);
  assert.equal(gh.state.patches, 2);
});

test('GitHub: token and access problems are explained; status counts the products', async () => {
  await assert.rejects(client(fakeGitHub({ status: 401 }).fetchImpl).add(DOOR, { ext: 'jpg', data: JPEG }, 'o'), (e: CatalogError) => e.code === 'AUTH_FAILED' && /CATALOG_GITHUB_TOKEN/.test(e.message));
  await assert.rejects(client(fakeGitHub({ status: 403 }).fetchImpl).productCount(), (e: CatalogError) => e.code === 'PERMISSION_DENIED' && /Contents: read and write/.test(e.message));
  await assert.rejects(client(fakeGitHub({ status: 404 }).fetchImpl).productCount(), (e: CatalogError) => e.code === 'NOT_FOUND');
  assert.equal(await client(fakeGitHub().fetchImpl).productCount(), 2);
});

test('settings: WAD catalog by default, the token switches it on, bad values are refused', () => {
  const off = catalogConfig({} as NodeJS.ProcessEnv);
  assert.equal(off.repo, null);
  assert.match(off.problems.join(' '), /CATALOG_GITHUB_TOKEN is not set/);
  const on = catalogConfig({ CATALOG_GITHUB_TOKEN: 'github_pat_1234567890abcdefghij' } as NodeJS.ProcessEnv);
  assert.equal(on.repo, 'Reinel2004/WAD-CATALOG');
  assert.equal(on.branch, 'main');
  assert.equal(on.folder, 'WAD-CATALOG', "WAD's repository keeps the site in its WAD-CATALOG folder");
  assert.equal(catalogConfig({ CATALOG_GITHUB_TOKEN: 'github_pat_1234567890abcdefghij', CATALOG_GITHUB_FOLDER: '' } as NodeJS.ProcessEnv).folder, '');
  assert.equal(on.siteUrl, 'https://wadfurniture-catalog.vercel.app');
  assert.deepEqual(on.problems, []);
  for (const env of [{ CATALOG_GITHUB_FOLDER: 'a/../b' }, { CATALOG_GITHUB_REPO: '../etc' }, { CATALOG_GITHUB_BRANCH: 'a..b' }, { CATALOG_SITE_URL: 'http://x.example' }])
    assert.equal(catalogConfig({ CATALOG_GITHUB_TOKEN: 'github_pat_1234567890abcdefghij', ...env } as NodeJS.ProcessEnv).token, null);
});

test('Kat takes photos (not videos)', () => {
  assert.ok(checkImage('kat', { mimeType: 'image/jpeg', data: JPEG }).data);
  assert.throws(() => checkVideo('kat', { mimeType: 'video/mp4', bytes: 10, durationSec: 3, frames: [{ mimeType: 'image/jpeg', data: JPEG }] }), /does not take videos/);
});

test('HTTP: only allowed accounts add products, same-site only, and one approval adds one product', async () => {
  const users = `owner:admin:${await hashPassword('pw-owner-1')},mk:marketing:${await hashPassword('pw-mk-1')},ops:operations:${await hashPassword('pw-ops-1')}`;
  const { config } = loadConfig({ APP_USERS: users, TASK_LOG_FILE: '', STATIC_DIR: 'does-not-exist' } as NodeJS.ProcessEnv);
  const gh = fakeGitHub();
  const runner = new JobRunner({ finance: {} as FinanceSource, orders: {} as OrderSource, maxConcurrent: 1 });
  const stub = { status: () => ({ id: 'orders', name: 'x', state: 'not_configured', host: null, problems: [], capabilities: {} }) };
  const audit: Record<string, unknown>[] = [];
  const app = createApp({ config, auth: new Auth(config), runner, finance: stub as never, orders: stub as never, catalog: client(gh.fetchImpl), audit: (e) => audit.push(e) });
  const server = createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const req = (method: string, path: string, body: unknown, cookie: string, csrf = true) =>
    fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-wad-request': '1' } : {}) }, body: body === null ? null : JSON.stringify(body) });
  const login = async (u: string, p: string) => (await req('POST', '/api/auth/login', { username: u, password: p }, '')).headers.get('set-cookie')!.split(';')[0];
  try {
    const own = await login('owner', 'pw-owner-1');
    const mk = await login('mk', 'pw-mk-1');
    const ops = await login('ops', 'pw-ops-1');
    const body = { key: 'kat-job-12345', product: DOOR, image: { mimeType: 'image/jpeg', data: JPEG } };
    assert.equal((await req('GET', '/api/catalog/status', null, ops)).status, 403);
    assert.equal((await req('POST', '/api/catalog/products', body, ops)).status, 403);
    assert.equal((await req('POST', '/api/catalog/products', body, own, false)).status, 403);
    const st = ((await (await req('GET', '/api/catalog/status', null, mk)).json()) as { catalog: CatalogStatus }).catalog;
    assert.deepEqual([st.configured, st.repo, st.products], [true, 'WAD/catalog', 2]);
    assert.equal((await req('POST', '/api/catalog/products', { ...body, product: { ...DOOR, category: 'Chairs' } }, mk)).status, 400);
    assert.equal(gh.state.posts, 0, 'nothing sent to GitHub for an invalid product');

    const first = await req('POST', '/api/catalog/products', body, mk);
    assert.equal(first.status, 200);
    const added = ((await first.json()) as { product: CatalogAddResult }).product;
    assert.equal(added.productId, 10);
    const again = (await (await req('POST', '/api/catalog/products', body, mk)).json()) as { product: CatalogAddResult; repeated: boolean };
    assert.equal(again.repeated, true);
    assert.equal(again.product.commitSha, added.commitSha);
    assert.equal(gh.state.patches, 1, 'the same approval never adds a second product');
    assert.equal(countProducts(gh.files()['products.js']), 3);
    const log = audit.find((e) => e.event === 'catalog.added')!;
    assert.equal(log.user, 'mk');
    assert.ok(!JSON.stringify(audit).includes(JPEG), 'the photo is never logged');
  } finally {
    app.close();
    server.closeAllConnections();
    server.close();
  }
});
