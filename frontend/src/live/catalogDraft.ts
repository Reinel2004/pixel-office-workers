// Kat's catalog entry, read by code from her answer's labelled lines ("**Category:** Doors" …)
// to fill in the approval form. Anything missing or not one of the catalog's choices is left
// empty for the person to fill in; the server checks every field again before it is added.

import type { CatalogCategory, CatalogDoorType, CatalogProductInput } from '../../shared/live';
import { CATALOG_CATEGORIES, CATALOG_DOOR_TYPES, CATALOG_LIMITS } from '../../shared/live';

export interface CatalogDraft {
  category: CatalogCategory | '';
  doorType: CatalogDoorType | '';
  name: string;
  material: string;
  dimensions: string;
  /** Comma-separated, as the person edits them. */
  finishes: string;
  description: string;
}

export const EMPTY_DRAFT: CatalogDraft = { category: '', doorType: '', name: '', material: '', dimensions: '', finishes: '', description: '' };

function line(answer: string, label: string): string {
  const m = answer.match(new RegExp(`^[ \\t>*-]*\\*\\*${label}:?\\*\\*:?[ \\t]*(.*)$`, 'im'));
  return (m?.[1] ?? '').replace(/\*\*/g, '').trim();
}

const pick = <T extends string>(list: readonly T[], v: string): T | '' => {
  const k = v.toLowerCase().replace(/[^a-z]/g, '');
  return list.find((x) => x.toLowerCase().replace(/[^a-z]/g, '') === k) ?? '';
};

/** The draft in Kat's answer, or null when she wrote none (for example she asked a question). */
export function catalogDraftFrom(answer: string): CatalogDraft | null {
  const name = line(answer, 'Name');
  const category = pick(CATALOG_CATEGORIES, line(answer, 'Category'));
  if (!name && !category) return null;
  const empty = (v: string) => (/^(none|n\/a|-|—|empty|unknown)$/i.test(v) ? '' : v);
  return {
    category,
    doorType: category === 'Doors' ? pick(CATALOG_DOOR_TYPES, line(answer, 'Door type')) : '',
    name: name.slice(0, CATALOG_LIMITS.name),
    material: empty(line(answer, 'Material')).slice(0, CATALOG_LIMITS.material),
    dimensions: empty(line(answer, 'Dimensions')).slice(0, CATALOG_LIMITS.dimensions),
    finishes: empty(line(answer, 'Finishes')),
    description: line(answer, 'Description').slice(0, CATALOG_LIMITS.description),
  };
}

/** One photo's part of Kat's answer for several photos: her draft, or why she skipped it. */
export interface BatchEntry {
  draft: CatalogDraft;
  /** Kat's reason for leaving this photo out ("**Skip:** …"), or null. */
  skip: string | null;
}

/**
 * Kat's entries for several photos, matched to the photos by number ("**Catalog entry 2**" is
 * photo 2). Always returns `count` entries: a photo she wrote nothing for gets an empty draft for
 * the person to fill in.
 */
export function catalogDraftsFrom(answer: string, count: number): BatchEntry[] {
  const out: BatchEntry[] = Array.from({ length: count }, () => ({ draft: { ...EMPTY_DRAFT }, skip: null }));
  const heads = [...answer.matchAll(/^[ \t>#*-]*\*\*Catalog entry\s*(\d{1,2})\s*:?\*\*:?.*$/gim)];
  heads.forEach((h, i) => {
    const n = Number(h[1]);
    if (n < 1 || n > count) return;
    const part = answer.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1].index : undefined);
    const skip = line(part, 'Skip');
    out[n - 1] = { draft: catalogDraftFrom(part) ?? { ...EMPTY_DRAFT }, skip: skip || null };
  });
  return out;
}

/** What is still missing before the product can be added (empty = ready). */
export function draftProblems(d: CatalogDraft): string[] {
  const out: string[] = [];
  if (!d.category) out.push('Choose a category.');
  if (d.category === 'Doors' && !d.doorType) out.push('Choose a door type.');
  if (d.name.trim().length < 3) out.push('Give the product a name.');
  if (!d.material.trim()) out.push('Fill in the material.');
  if (d.description.trim().length < 5) out.push('Write a short description.');
  if (splitFinishes(d.finishes).length > CATALOG_LIMITS.finishes) out.push(`List at most ${CATALOG_LIMITS.finishes} finishes.`);
  return out;
}

export const splitFinishes = (s: string) => [...new Set(s.split(',').map((f) => f.trim()).filter(Boolean))];

/** The product to send (call only when draftProblems() is empty). */
export function toProduct(d: CatalogDraft): CatalogProductInput {
  return {
    category: d.category as CatalogCategory,
    doorType: d.category === 'Doors' ? (d.doorType as CatalogDoorType) : null,
    name: d.name.trim(),
    material: d.material.trim(),
    dimensions: d.dimensions.trim(),
    finishes: splitFinishes(d.finishes),
    description: d.description.trim(),
  };
}
