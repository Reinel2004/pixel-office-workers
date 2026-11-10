// Tess, Quality Control Assistant: an inspection checklist built BY CODE from an order's piece
// specifications (dimensions, design, finish, jamb and hardware). Nothing here is guessed: every
// expected value is copied from the order, and anything the order does not record is marked
// "not recorded — confirm with sales". Shared by the server (Connected Mode) and the browser
// (Demo Mode samples), so both build exactly the same checklist.

import type { ChecklistGroup, ChecklistItem, InspectionChecklist, OrderSpec, PieceSpec } from './live';

const HARDWARE: { label: string; re: RegExp }[] = [
  { label: 'hinges', re: /\b(hinges?|bisagra)\b/i },
  { label: 'lockset', re: /\b(lock ?sets?|locks?|seradura|serradura|deadbolts?|kandado)\b/i },
  { label: 'door knob', re: /\b(door ?knobs?|knobs?)\b/i },
  { label: 'handle', re: /\b(handles?|hawakan|pull ?bars?)\b/i },
  { label: 'lever handle', re: /\blevers?\b/i },
  { label: 'door closer', re: /\b(door ?closers?|closers?)\b/i },
  { label: 'bolt / latch', re: /\b(barrel ?bolts?|flush ?bolts?|trangka|latch(es)?)\b/i },
  { label: 'door stopper', re: /\b(door ?stop(per)?s?|stoppers?)\b/i },
  { label: 'peephole', re: /\b(peep ?holes?|door ?viewers?)\b/i },
  { label: 'drawer slides', re: /\b(drawer ?slides?|slides?|riles)\b/i },
];

/** Hardware words found in free-text notes (English or Filipino), as short labels. */
export function hardwareMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  return HARDWARE.filter((h) => h.re.test(text)).map((h) => h.label);
}

const isDoor = (p: PieceSpec) => /door|pinto/i.test(p.category ?? '') || (!p.category && (!!p.thickness || !!p.jamb));
const isDining = (p: PieceSpec) => /dining|table|mesa/i.test(p.category ?? '') || !!(p.length || p.width || p.height || p.tableShape);
const hasJamb = (j: string | null) => !!j && /with/i.test(j) && !/without/i.test(j);
const noJamb = (j: string | null) => !!j && /without|none|no hamba/i.test(j);
const unfinished = (f: string | null) => !!f && /without|unfinished|raw|walang/i.test(f);

function groupKey(p: PieceSpec) {
  const { stage: _stage, ...rest } = p;
  return JSON.stringify(rest);
}

export function buildChecklist(spec: OrderSpec, builtAt: string, source: InspectionChecklist['source'] = 'live'): InspectionChecklist {
  const groups = new Map<string, { piece: PieceSpec; qty: number; stages: Set<string> }>();
  for (const p of spec.pieces) {
    const k = groupKey(p);
    const g = groups.get(k) ?? { piece: p, qty: 0, stages: new Set<string>() };
    g.qty++;
    if (p.stage) g.stages.add(p.stage);
    groups.set(k, g);
  }

  let missing = 0;
  let doors = 0;
  const out: ChecklistGroup[] = [];
  [...groups.values()].forEach(({ piece: p, qty, stages }, gi) => {
    const items: ChecklistItem[] = [];
    const add = (area: ChecklistItem['area'], text: string, expected: string | null = null, opts: { needs?: boolean } = {}) => {
      const isMissing = opts.needs === true && !expected;
      if (isMissing) missing++;
      items.push({ id: `g${gi + 1}-${items.length + 1}`, area, text, expected, ...(isMissing ? { missing: true } : {}) });
    };
    const door = isDoor(p);
    const dining = isDining(p);
    if (door) doors++;

    // Dimensions
    if (dining) {
      const dims = [p.length, p.width, p.height];
      add('dimensions', 'Measure length × width × height', dims.every(Boolean) ? `${p.length} × ${p.width} × ${p.height}` : dims.some(Boolean) ? `${p.length ?? '?'} × ${p.width ?? '?'} × ${p.height ?? '?'} (incomplete)` : null, { needs: true });
      add('dimensions', 'Table shape', p.tableShape, { needs: true });
      add('dimensions', 'Top is level and does not wobble on a flat floor');
    } else {
      add('dimensions', door ? 'Measure the size (height × width)' : 'Measure the size', p.size, { needs: true });
      if (door) add('dimensions', 'Measure the thickness', p.thickness, { needs: true });
      else if (p.thickness) add('dimensions', 'Measure the thickness', p.thickness);
    }
    if (door) add('dimensions', 'Square: both diagonals measure the same; no warping or twisting (check with a straight edge)');

    // Design (and material)
    add('design', 'Design matches the order', p.type, { needs: true });
    if (p.hasDesignPhoto) add('design', 'Compare with the design photo attached to the order', 'Design photo in WAD Order Management');
    if (p.cnc === true) add('design', 'CNC carving / cuts are complete, clean and sharp', 'CNC: yes');
    add('design', 'Wood is as ordered', p.wood, { needs: true });
    add('design', 'No cracks, splits, knots that fall out, gaps or loose joints');

    // Finish
    if (unfinished(p.finish)) add('finish', 'Left unfinished as ordered: sanded smooth, no varnish applied', p.finish);
    else {
      add('finish', 'Finish is as ordered', p.finish, { needs: true });
      add('finish', 'Even coat: no drips, runs, bubbles, dust or bare spots; edges and back finished too');
    }
    if (p.hasColorSample) add('finish', 'Colour matches the colour sample attached to the order', 'Colour sample in WAD Order Management');
    add('finish', 'Sanded smooth to the touch, no scratches or sanding marks');

    // Jamb (hamba)
    if (hasJamb(p.jamb)) {
      add('jamb', 'Jamb (hamba) is included', p.jamb);
      add('jamb', 'Jamb wood', p.jambWood, { needs: true });
      add('jamb', 'Jamb size', p.jambSize, { needs: true });
      add('jamb', 'Door fits the jamb: even gap on all sides; opens and closes without rubbing');
      add('jamb', 'Jamb is square and its corners are tight');
    } else if (noJamb(p.jamb)) {
      add('jamb', 'No jamb ordered: door only (do not pack a jamb)', p.jamb);
    } else if (door) {
      add('jamb', 'Jamb (hamba): with or without?', null, { needs: true });
    }

    // Hardware: the order system has no hardware fields, only the notes.
    const hw = hardwareMentions(p.notes);
    if (hw.length) add('hardware', 'Hardware mentioned in the notes is fitted and works', hw.join(', '));
    else add('hardware', door ? 'Hardware (hinges, lockset, handle): not recorded in the order' : 'Hardware (handles, knobs, slides), if any: not recorded in the order', null, { needs: true });
    if (door) add('hardware', 'If hardware is fitted: hinges and lock aligned, screws tight, door swings freely and latches');

    // General
    add('general', 'Order number label is on the piece', spec.ref);
    add('general', 'Clean: no pencil marks, glue or sawdust');
    add('general', 'Protected for delivery (corners and faces wrapped)');

    const label = [p.category ?? 'Piece', p.type ?? 'design not recorded', p.wood, p.finish].filter(Boolean).join(' · ');
    out.push({ label, qty, stages: [...stages], items, notes: p.notes ? [p.notes] : [] });
  });

  const warnings: string[] = [];
  if (!spec.pieces.length) warnings.push('WAD Order Management returned no pieces for this order.');
  if (missing) warnings.push(`${missing} check(s) are marked "not recorded": the order does not say what to expect. Confirm them with sales before inspecting.`);
  if (doors || spec.pieces.length) warnings.push('Hardware is not a field in WAD Order Management; it appears only when staff wrote it in the notes.');
  if (spec.truncated) warnings.push('The order has more pieces than the office reads at once; only the first ones are listed.');
  return { ref: spec.ref, status: spec.status, dueDate: spec.dueDate, pieces: spec.pieces.length, groups: out, warnings, builtAt, source };
}

/** Plain text for copying or printing: one line per check, with a box to tick. */
export function checklistText(c: InspectionChecklist, customer?: string | null): string {
  const AREA: Record<ChecklistItem['area'], string> = { dimensions: 'Dimensions', design: 'Design & wood', finish: 'Finish', jamb: 'Jamb (hamba)', hardware: 'Hardware', general: 'General' };
  const lines = [
    `Inspection checklist — ${c.ref}${customer ? ` (${customer})` : ''}${c.source === 'demo' ? ' — DEMO SAMPLE' : ''}`,
    `${c.pieces} piece(s)${c.status ? ` · ${c.status}` : ''}${c.dueDate ? ` · due ${c.dueDate}` : ''}`,
    '',
  ];
  for (const g of c.groups) {
    lines.push(`${g.qty} × ${g.label}`);
    for (const area of Object.keys(AREA) as ChecklistItem['area'][]) {
      const items = g.items.filter((i) => i.area === area);
      if (!items.length) continue;
      lines.push(`  ${AREA[area]}`);
      for (const i of items) lines.push(`  [ ] ${i.text}${i.expected ? `: ${i.expected}` : ''}${i.missing ? ' — NOT RECORDED, confirm with sales' : ''}`);
    }
    for (const n of g.notes) lines.push(`  Notes: ${n}`);
    lines.push('');
  }
  for (const w of c.warnings) lines.push(`! ${w}`);
  lines.push('', 'Inspected by: ____________   Date: ____________   Passed / Needs rework');
  return lines.join('\n');
}
