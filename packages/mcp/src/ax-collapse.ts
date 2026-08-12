/**
 * Post-filter for desktop_read_ui (vanta-ax `dump`) output — collapses junk element runs so
 * animated odometer digits / decorative wrappers stop eating the element budget (measured:
 * ~40% of an 80-element budget was ≤2-char sibling AXStaticText runs on one real page).
 * Pure and daemon-free so it can be unit-tested with plain node. Applied ONLY in the MCP
 * handler — the daemon and the vanta-ax binary are untouched (rebuilding vanta-ax voids TCC).
 *
 * Rules (conservative — never touches elements with AXPress in actions, a title, or focused:true):
 *  1. Within one parent, a run of ≥4 consecutive sibling AXStaticText elements whose value is
 *     ≤2 chars (or AXGroup wrappers with empty value around exactly one such child) collapses
 *     into ONE synthetic AXStaticText carrying the joined values + `collapsed: N`.
 *  2. An AXGroup with no value/title and no real actions (beyond AXShowMenu/AXScrollToVisible)
 *     is dropped when its frame duplicates its single child's frame (pure wrapper).
 * Surviving elements keep their ORIGINAL ids (desktop_act references them) — never renumbered.
 */

export interface AxElement {
  id: number;
  role: string;
  subrole?: string;
  title?: string;
  value?: string;
  frame?: number[];
  enabled?: boolean;
  focused?: boolean;
  actions?: string[];
  path: string;
  /** Present only on synthetic run-collapse elements: how many originals it replaces. */
  collapsed?: number;
}

const WRAPPER_ONLY_ACTIONS = new Set(['AXShowMenu', 'AXScrollToVisible']);

function parentOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i === -1 ? '' : path.slice(0, i);
}

function isProtected(el: AxElement): boolean {
  return el.focused === true || Boolean(el.title) || Boolean(el.actions?.includes('AXPress'));
}

function isShortStatic(el: AxElement): boolean {
  return el.role === 'AXStaticText' && (el.value ?? '').length <= 2 && !isProtected(el);
}

function frameUnion(frames: Array<number[] | undefined>): number[] | undefined {
  const fs = frames.filter((f): f is number[] => Array.isArray(f) && f.length === 4);
  if (fs.length === 0) return undefined;
  const x0 = Math.min(...fs.map((f) => f[0]));
  const y0 = Math.min(...fs.map((f) => f[1]));
  const x1 = Math.max(...fs.map((f) => f[0] + f[2]));
  const y1 = Math.max(...fs.map((f) => f[1] + f[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

function sameFrame(a?: number[], b?: number[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
  return a.every((v, i) => Math.abs(v - b[i]) <= 1);
}

export function collapseAxElements(elements: AxElement[]): { elements: AxElement[]; removed: number } {
  if (!Array.isArray(elements) || elements.length === 0) return { elements: elements ?? [], removed: 0 };

  // Direct children per parent path, in document (array) order.
  const childrenOf = new Map<string, AxElement[]>();
  for (const el of elements) {
    if (typeof el?.path !== 'string') return { elements, removed: 0 }; // malformed dump — leave alone
    const p = parentOf(el.path);
    const arr = childrenOf.get(p);
    if (arr) arr.push(el); else childrenOf.set(p, [el]);
  }

  // A run member is a short static, or an AXGroup with empty value wrapping exactly one short-static
  // child. Returns the elements the member consumes + the value it contributes, or null.
  const runMember = (el: AxElement): { consumes: AxElement[]; value: string } | null => {
    if (isShortStatic(el)) return { consumes: [el], value: el.value ?? '' };
    if (el.role === 'AXGroup' && !el.value && !isProtected(el)) {
      const kids = childrenOf.get(el.path) ?? [];
      if (kids.length === 1 && isShortStatic(kids[0])) return { consumes: [el, kids[0]], value: kids[0].value ?? '' };
    }
    return null;
  };

  const removedIds = new Set<number>();
  const syntheticFor = new Map<number, AxElement>(); // first-run-member id → synthetic replacement

  // Pass 1 — collapse maximal runs of ≥4 consecutive collapsible siblings within each parent.
  for (const siblings of childrenOf.values()) {
    let i = 0;
    while (i < siblings.length) {
      const members: Array<{ el: AxElement; consumes: AxElement[]; value: string }> = [];
      let j = i;
      while (j < siblings.length) {
        const m = runMember(siblings[j]);
        if (!m) break;
        members.push({ el: siblings[j], ...m });
        j++;
      }
      if (members.length >= 4) {
        const consumed = members.flatMap((m) => m.consumes);
        const first = members[0].el;
        const synthetic: AxElement = {
          id: first.id, // original id preserved — still resolvable by desktop_act
          role: 'AXStaticText',
          value: members.map((m) => m.value).join(''),
          collapsed: consumed.length,
          path: first.path,
          frame: frameUnion(members.map((m) => m.el.frame)) ?? first.frame,
        };
        for (const c of consumed) removedIds.add(c.id);
        syntheticFor.set(first.id, synthetic);
        i = j;
      } else {
        i++;
      }
    }
  }

  // Pass 2 — drop pure wrapper AXGroups whose frame duplicates their single surviving child's frame.
  for (const el of elements) {
    if (removedIds.has(el.id) || syntheticFor.has(el.id)) continue;
    if (el.role !== 'AXGroup' || el.value || isProtected(el)) continue;
    const acts = el.actions ?? [];
    if (!acts.every((a) => WRAPPER_ONLY_ACTIONS.has(a))) continue;
    const kids = (childrenOf.get(el.path) ?? []).filter((k) => syntheticFor.has(k.id) || !removedIds.has(k.id));
    if (kids.length !== 1) continue;
    const child = syntheticFor.get(kids[0].id) ?? kids[0];
    if (sameFrame(el.frame, child.frame)) removedIds.add(el.id);
  }

  const out: AxElement[] = [];
  for (const el of elements) {
    const syn = syntheticFor.get(el.id);
    if (syn) { out.push(syn); continue; }
    if (removedIds.has(el.id)) continue;
    out.push(el);
  }
  return { elements: out, removed: elements.length - out.length };
}
