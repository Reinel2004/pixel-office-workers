// The online catalog with Kat: she drafts a product from a photo, a person checks and edits every
// field here, and only "Add to catalog" sends it (the photo and the entry go to the catalog's
// GitHub repository in one change; the site updates itself about a minute later).

import { useState } from 'react';
import type { CatalogAddResult, Job } from '../../../shared/live';
import { CATALOG_CATEGORIES, CATALOG_DOOR_TYPES, CATALOG_LIMITS } from '../../../shared/live';
import { catalogDraftFrom, draftProblems, EMPTY_DRAFT, toProduct, type CatalogDraft } from '../../live/catalogDraft';
import type { LiveStore } from '../../live/store';
import { IconCheck } from '../icons';
import { useLive } from './LiveViews';

/** Products added from tasks in this tab (job id -> result), so the form shows "added" after reopening. */
const added = new Map<string, CatalogAddResult>();

function SiteLinks({ r, siteUrl }: { r: CatalogAddResult | null; siteUrl: string | null }) {
  return (
    <span className="row wrap gap-s">
      {siteUrl && (
        <a className="btn sm" href={siteUrl} target="_blank" rel="noopener noreferrer">
          Open the catalog
        </a>
      )}
      {r?.commitUrl && (
        <a className="btn sm ghost" href={r.commitUrl} target="_blank" rel="noopener noreferrer">
          See the change on GitHub
        </a>
      )}
    </span>
  );
}

/** Under Kat's finished answer: check the entry, then add it to the catalog. */
export function CatalogFromTask({ store, job }: { store: LiveStore; job: Job }) {
  useLive(store);
  const answer = job.steps[0]?.result?.answer ?? '';
  const [draft, setDraft] = useState<CatalogDraft>(() => catalogDraftFrom(answer) ?? EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CatalogAddResult | null>(() => added.get(job.id) ?? null);
  if (!store.user?.permissions.includes('catalog:write')) return null;
  const can = store.canAddToCatalog();
  const photo = store.images.get(job.id) ?? null;

  if (done)
    return (
      <section className="cat-form stack">
        <p className="fb-done">
          <IconCheck size={15} /> Added to the catalog as product {done.productId}.
        </p>
        <p className="muted small">The catalog website updates itself in about a minute (when Vercel has rebuilt it). Refresh the catalog page if you don't see it yet.</p>
        <SiteLinks r={done} siteUrl={done.siteUrl} />
      </section>
    );
  if (!can.ok) return <p className="muted small">Catalog: {can.reason}</p>;
  if (!catalogDraftFrom(answer) && !job.image) return null; // a question or a general answer, not a product

  const set = <K extends keyof CatalogDraft>(k: K) => (v: CatalogDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const problems = draftProblems(draft);
  const add = async () => {
    if (busy || problems.length || !photo) return;
    setBusy(true);
    setError(null);
    try {
      // One key per Kat task: a second click or a resend never adds the product twice.
      const r = await store.addToCatalog({ key: `kat-${job.id}`, product: toProduct(draft), photo });
      added.set(job.id, r);
      setDone(r);
      if (job.status === 'ready_for_review') store.completeJob(job.id);
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
        <label className="wide">
          Name
          <input value={draft.name} maxLength={CATALOG_LIMITS.name} onChange={(e) => set('name')(e.target.value)} />
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
          <textarea rows={3} value={draft.description} maxLength={CATALOG_LIMITS.description} onChange={(e) => set('description')(e.target.value)} />
        </label>
      </div>
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
        Clicking Add puts this photo and entry on the live catalog ({store.catalog?.siteUrl?.replace(/^https:\/\//, '') ?? 'the catalog website'}) for everyone to see. Existing products are never changed; to remove one later, edit products.js in the catalog repository.
      </p>
    </section>
  );
}

/** Kat's panel: whether the catalog is connected, how many products it has, and how to add one. */
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
          <p className="muted small">To add a product: choose Kat, click Photo, pick the product photo, add any details (size, wood, door type) and click Assign. Check her entry in the task and click Add to catalog.</p>
          <SiteLinks r={null} siteUrl={c?.siteUrl ?? null} />
        </>
      )}
    </section>
  );
}
