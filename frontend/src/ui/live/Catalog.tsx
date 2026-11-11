// The online catalog with Kat: she drafts products from photos, a person checks and edits every
// field here, and only "Add to catalog" sends them (the photos and the entries go to the catalog's
// GitHub repository in one change; the site updates itself about a minute later).

import { useState } from 'react';
import type { CatalogAddResult, CatalogBatchResult, Job } from '../../../shared/live';
import { CATALOG_CATEGORIES, CATALOG_DOOR_TYPES, CATALOG_LIMITS } from '../../../shared/live';
import { catalogDraftFrom, catalogDraftsFrom, draftProblems, EMPTY_DRAFT, toProduct, type CatalogDraft } from '../../live/catalogDraft';
import type { LiveStore } from '../../live/store';
import { IconCheck } from '../icons';
import { useLive } from './LiveViews';

/** What was added from tasks in this tab (job id -> result), so the form shows "added" after reopening. */
const added = new Map<string, CatalogBatchResult>();

const asBatch = (r: CatalogAddResult, name: string): CatalogBatchResult => ({
  products: [{ productId: r.productId, imagePath: r.imagePath, name }],
  commitSha: r.commitSha,
  commitUrl: r.commitUrl,
  siteUrl: r.siteUrl,
});

function SiteLinks({ commitUrl, siteUrl }: { commitUrl: string | null; siteUrl: string | null }) {
  return (
    <span className="row wrap gap-s">
      {siteUrl && (
        <a className="btn sm" href={siteUrl} target="_blank" rel="noopener noreferrer">
          Open the catalog
        </a>
      )}
      {commitUrl && (
        <a className="btn sm ghost" href={commitUrl} target="_blank" rel="noopener noreferrer">
          See the change on GitHub
        </a>
      )}
    </span>
  );
}

function Added({ r }: { r: CatalogBatchResult }) {
  const one = r.products.length === 1;
  return (
    <section className="cat-form stack">
      <p className="fb-done">
        <IconCheck size={15} /> {one ? `Added to the catalog as product ${r.products[0].productId}.` : `${r.products.length} products added to the catalog.`}
      </p>
      {!one && (
        <ul className="cat-added">
          {r.products.map((p) => (
            <li key={p.productId}>
              <b>{p.productId}</b> {p.name}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">The catalog website updates itself in about a minute (when Vercel has rebuilt it). Refresh the catalog page if you don't see {one ? 'it' : 'them'} yet.</p>
      <SiteLinks commitUrl={r.commitUrl} siteUrl={r.siteUrl} />
    </section>
  );
}

/** The fields of one catalog entry. */
function DraftFields({ draft, onChange, idPrefix }: { draft: CatalogDraft; onChange: (d: CatalogDraft) => void; idPrefix: string }) {
  const set = <K extends keyof CatalogDraft>(k: K) => (v: CatalogDraft[K]) => onChange({ ...draft, [k]: v });
  return (
    <div className="cat-grid">
      <label>
        Category
        <select value={draft.category} onChange={(e) => set('category')(e.target.value as CatalogDraft['category'])}>
          <option value="">Choose…</option>
          {CATALOG_CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      {draft.category === 'Doors' && (
        <label>
          Door type
          <select value={draft.doorType} onChange={(e) => set('doorType')(e.target.value as CatalogDraft['doorType'])}>
            <option value="">Choose…</option>
            {CATALOG_DOOR_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
      )}
      <label className="wide" htmlFor={`${idPrefix}-name`}>
        Name
        <input id={`${idPrefix}-name`} value={draft.name} maxLength={CATALOG_LIMITS.name} onChange={(e) => set('name')(e.target.value)} />
      </label>
      <label>
        Material
        <input value={draft.material} maxLength={CATALOG_LIMITS.material} onChange={(e) => set('material')(e.target.value)} />
      </label>
      <label>
        Dimensions
        <input value={draft.dimensions} maxLength={CATALOG_LIMITS.dimensions} placeholder="e.g. 80-90 x 210cm (optional)" onChange={(e) => set('dimensions')(e.target.value)} />
      </label>
      <label className="wide">
        Finishes <span className="muted">(separate with commas)</span>
        <input value={draft.finishes} maxLength={200} onChange={(e) => set('finishes')(e.target.value)} />
      </label>
      <label className="wide">
        Description
        <textarea rows={2} value={draft.description} maxLength={CATALOG_LIMITS.description} onChange={(e) => set('description')(e.target.value)} />
      </label>
    </div>
  );
}

const siteName = (store: LiveStore) => store.catalog?.siteUrl?.replace(/^https:\/\//, '') ?? 'the catalog website';

/** Under Kat's finished answer: check the entry (or entries), then add to the catalog. */
export function CatalogFromTask({ store, job }: { store: LiveStore; job: Job }) {
  useLive(store);
  const [done, setDone] = useState<CatalogBatchResult | null>(() => added.get(job.id) ?? null);
  if (!store.user?.permissions.includes('catalog:write')) return null;
  if (done) return <Added r={done} />;
  const can = store.canAddToCatalog();
  if (!can.ok) return <p className="muted small">Catalog: {can.reason}</p>;
  const finish = (r: CatalogBatchResult) => {
    added.set(job.id, r);
    setDone(r);
    if (job.status === 'ready_for_review') store.completeJob(job.id);
  };
  return job.photos ? <BatchForm store={store} job={job} onDone={finish} /> : <SingleForm store={store} job={job} onDone={finish} />;
}

function SingleForm({ store, job, onDone }: { store: LiveStore; job: Job; onDone: (r: CatalogBatchResult) => void }) {
  const answer = job.steps[0]?.result?.answer ?? '';
  const [draft, setDraft] = useState<CatalogDraft>(() => catalogDraftFrom(answer) ?? EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photo = store.images.get(job.id) ?? null;
  if (!catalogDraftFrom(answer) && !job.image) return null; // a question or a general answer, not a product
  const problems = draftProblems(draft);
  const add = async () => {
    if (busy || problems.length || !photo) return;
    setBusy(true);
    setError(null);
    try {
      // One key per Kat task: a second click or a resend never adds the product twice.
      const product = toProduct(draft);
      onDone(asBatch(await store.addToCatalog({ key: `kat-${job.id}`, product, photo }), product.name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="cat-form stack">
      <h3>Add to the catalog</h3>
      {photo ? (
        <img className="cat-photo" src={photo} alt="Product photo for the catalog" />
      ) : (
        <p className="photo-note small">The photo is not in this browser any more (photos are not kept after a page reload). Assign the task to Kat again with the photo.</p>
      )}
      <DraftFields draft={draft} onChange={setDraft} idPrefix={`cat-${job.id}`} />
      {problems.length > 0 && <p className="muted small">{problems.join(' ')}</p>}
      {error && (
        <p className="photo-note small" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap gap-s">
        <button className="btn primary" disabled={busy || problems.length > 0 || !photo} onClick={() => void add()}>
          <IconCheck size={15} /> {busy ? 'Adding…' : 'Add to catalog'}
        </button>
      </div>
      <p className="muted small">
        Clicking Add puts this photo and entry on the live catalog ({siteName(store)}) for everyone to see. Existing products are never changed; to remove one later, edit products.js in the catalog repository.
      </p>
    </section>
  );
}

/** Several photos: one card per photo with Kat's entry; tick the ones to add, then add them in one change. */
function BatchForm({ store, job, onDone }: { store: LiveStore; job: Job; onDone: (r: CatalogBatchResult) => void }) {
  const answer = job.steps[0]?.result?.answer ?? '';
  const count = job.photos!.count;
  const [rows, setRows] = useState(() => catalogDraftsFrom(answer, count).map((e) => ({ ...e, include: !e.skip })));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const photos = store.catalogPhotos.get(job.id) ?? null;
  if (!photos)
    return <p className="photo-note small">The {count} photos are not in this browser any more (photos are not kept after a page reload). Assign the task to Kat again with the photos.</p>;

  const chosen = rows.map((r, i) => ({ ...r, i })).filter((r) => r.include);
  const problems = chosen.flatMap((r) => draftProblems(r.draft).map((p) => `Photo ${r.i + 1}: ${p}`));
  const update = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const add = async () => {
    if (busy || problems.length || !chosen.length) return;
    setBusy(true);
    setError(null);
    try {
      // One key per Kat task: a second click or a resend never adds the products twice.
      const r = await store.addManyToCatalog({ key: `kat-${job.id}`, items: chosen.map((c) => ({ product: toProduct(c.draft), photo: photos[c.i] })) }, setProgress);
      onDone(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cat-form stack">
      <h3>Add to the catalog ({count} photos)</h3>
      <p className="muted small">Check each product. Untick any you don't want to add.</p>
      {rows.map((r, i) => (
        <div key={i} className={`cat-item${r.include ? '' : ' off'}`}>
          <div className="cat-item-head">
            <img src={photos[i]} alt={`Photo ${i + 1}`} />
            <label className="fb-confirm">
              <input type="checkbox" checked={r.include} disabled={busy} onChange={(e) => update(i, { include: e.target.checked })} />
              <b>Photo {i + 1}</b> {r.include ? '— add this product' : '— leave out'}
            </label>
          </div>
          {r.skip && <p className="photo-note small">Kat: {r.skip}</p>}
          {r.include && <DraftFields draft={r.draft} onChange={(d) => update(i, { draft: d })} idPrefix={`cat-${job.id}-${i}`} />}
        </div>
      ))}
      {problems.length > 0 && <p className="muted small">{problems.join(' ')}</p>}
      {error && (
        <p className="photo-note small" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap gap-s">
        <button className="btn primary" disabled={busy || problems.length > 0 || !chosen.length} onClick={() => void add()}>
          <IconCheck size={15} /> {busy ? progress || 'Adding…' : `Add ${chosen.length} ${chosen.length === 1 ? 'product' : 'products'} to catalog`}
        </button>
      </div>
      <p className="muted small">
        Clicking Add puts the ticked photos and entries on the live catalog ({siteName(store)}) for everyone to see, in one change. Existing products are never changed; to remove one later, edit products.js in the catalog repository.
      </p>
    </section>
  );
}

/** Kat's panel: whether the catalog is connected, how many products it has, and how to add some. */
export function CatalogPanel({ store }: { store: LiveStore }) {
  useLive(store);
  if (!store.user?.permissions.includes('catalog:write')) return null;
  const can = store.canAddToCatalog();
  const c = store.catalog;
  return (
    <section>
      <h3>Online catalog</h3>
      {!can.ok ? (
        <p className="muted small">{can.reason}</p>
      ) : (
        <>
          <p className="muted small">
            Connected to <b>{c?.repo}</b> ({c?.branch}){c?.products !== null && c?.products !== undefined ? ` · ${c.products} products on the site` : ''}.
          </p>
          {c?.problems.length ? <p className="photo-note small">{c.problems.join(' ')}</p> : null}
          <p className="muted small">
            To add products: choose Kat, click Photo and pick one photo, or up to 10 photos of different products at once. Add any details (size, wood, door type) and click Assign. Check her entries in the task and click Add to catalog.
          </p>
          <SiteLinks commitUrl={null} siteUrl={c?.siteUrl ?? null} />
        </>
      )}
    </section>
  );
}
