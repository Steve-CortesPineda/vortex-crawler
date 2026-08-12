// Unit test for the desktop_read_ui junk-element collapse (EVE fix plan #4).
// Pure — imports nothing from the daemon. Node >=23 strips the .ts types natively.
// Run: node packages/mcp/test/ax-collapse.test.mjs
import assert from 'node:assert/strict';
import { collapseAxElements } from '../src/ax-collapse.ts';

const digit = (id, i, extra = {}) => ({
  id, role: 'AXStaticText', value: String(i % 10),
  frame: [100 + i * 12, 200, 12, 20], path: `0.5.${i}`, ...extra,
});

// ── 1. A run of 10 single-digit AXStaticText siblings collapses to 1 ─────────
{
  const els = Array.from({ length: 10 }, (_, i) => digit(i, i));
  const { elements, removed } = collapseAxElements(els);
  assert.equal(elements.length, 1, 'run of 10 collapses to 1');
  assert.equal(removed, 9);
  const syn = elements[0];
  assert.equal(syn.id, 0, 'synthetic keeps first sibling id');
  assert.equal(syn.role, 'AXStaticText');
  assert.equal(syn.value, '0123456789', 'values joined');
  assert.equal(syn.collapsed, 10);
  assert.equal(syn.path, '0.5.0', 'first sibling path');
  assert.deepEqual(syn.frame, [100, 200, 120, 20], 'union frame spans the run');
}

// ── 2. Elements with AXPress or a title survive (and break the run) ──────────
{
  const els = [
    ...Array.from({ length: 4 }, (_, i) => digit(i, i)),                       // run A (collapses)
    digit(4, 4, { actions: ['AXPress'], path: '0.5.4' }),                      // pressable — survives
    digit(5, 5, { title: 'Speed', path: '0.5.5' }),                            // titled — survives
    ...Array.from({ length: 4 }, (_, i) => digit(6 + i, 6 + i, undefined)).map((e, i) => ({ ...e, path: `0.5.${6 + i}` })), // run B
    digit(10, 0, { focused: true, path: '0.5.10' }),                           // focused — survives
  ];
  const { elements, removed } = collapseAxElements(els);
  const ids = elements.map((e) => e.id);
  assert.ok(ids.includes(4), 'AXPress element survives');
  assert.ok(ids.includes(5), 'titled element survives');
  assert.ok(ids.includes(10), 'focused element survives');
  assert.equal(elements.length, 5, 'two synthetics + three protected'); // syn(0), 4, 5, syn(6), 10
  assert.equal(removed, 11 - 5);
  const synA = elements.find((e) => e.id === 0);
  const synB = elements.find((e) => e.id === 6);
  assert.equal(synA.collapsed, 4);
  assert.equal(synB.collapsed, 4);
  assert.equal(synB.value, '6789');
}

// ── 3. Fewer than 4 collapsible siblings — nothing happens ───────────────────
{
  const els = Array.from({ length: 3 }, (_, i) => digit(i, i));
  const { elements, removed } = collapseAxElements(els);
  assert.equal(elements.length, 3, 'run of 3 untouched');
  assert.equal(removed, 0);
}

// ── 4. ids preserved on survivors — never renumbered ─────────────────────────
{
  const els = [
    { id: 0, role: 'AXButton', title: 'Save', path: '0.0', actions: ['AXPress'] },
    ...Array.from({ length: 5 }, (_, i) => digit(1 + i, i, { path: `0.5.${i}` })),
    { id: 6, role: 'AXTextField', value: 'hello there world', path: '0.9' },
  ];
  const { elements } = collapseAxElements(els);
  assert.deepEqual(elements.map((e) => e.id), [0, 1, 6], 'original ids intact, no renumbering');
}

// ── 5. AXGroup wrappers with empty value + one short child join the run ──────
{
  const els = [];
  for (let i = 0; i < 6; i++) {
    els.push({ id: i * 2, role: 'AXGroup', frame: [100 + i * 12, 200, 12, 20], path: `0.5.${i}` });
    els.push({ id: i * 2 + 1, role: 'AXStaticText', value: String(i), frame: [100 + i * 12, 200, 12, 20], path: `0.5.${i}.0` });
  }
  const { elements, removed } = collapseAxElements(els);
  assert.equal(elements.length, 1, 'group-wrapped digit run collapses to 1');
  assert.equal(removed, 11);
  assert.equal(elements[0].value, '012345');
  assert.equal(elements[0].collapsed, 12, 'consumed groups + children counted');
}

// ── 6. Pure wrapper AXGroup with duplicate frame of its single child is dropped ──
{
  const els = [
    { id: 0, role: 'AXGroup', frame: [10, 10, 300, 40], path: '0.1', actions: ['AXScrollToVisible'] },
    { id: 1, role: 'AXStaticText', value: 'A real paragraph of visible text', frame: [10, 10, 300, 40], path: '0.1.0' },
    // wrapper with a DIFFERENT frame than its child — kept
    { id: 2, role: 'AXGroup', frame: [0, 0, 800, 600], path: '0.2' },
    { id: 3, role: 'AXStaticText', value: 'Another block of text here', frame: [20, 100, 300, 40], path: '0.2.0' },
    // wrapper with a title — kept even with duplicate frame
    { id: 4, role: 'AXGroup', title: 'Sidebar', frame: [500, 10, 200, 40], path: '0.3' },
    { id: 5, role: 'AXStaticText', value: 'Sidebar text content here', frame: [500, 10, 200, 40], path: '0.3.0' },
    // wrapper with a real action (AXPress) — kept
    { id: 6, role: 'AXGroup', frame: [10, 300, 100, 30], path: '0.4', actions: ['AXPress'] },
    { id: 7, role: 'AXStaticText', value: 'Clickable label text here', frame: [10, 300, 100, 30], path: '0.4.0' },
  ];
  const { elements, removed } = collapseAxElements(els);
  const ids = elements.map((e) => e.id);
  assert.ok(!ids.includes(0), 'duplicate-frame pure wrapper dropped');
  assert.ok(ids.includes(1), 'its child survives');
  assert.ok(ids.includes(2), 'different-frame wrapper kept');
  assert.ok(ids.includes(4), 'titled wrapper kept');
  assert.ok(ids.includes(6), 'pressable wrapper kept');
  assert.equal(removed, 1);
}

// ── 7. Long-value statics never collapse ─────────────────────────────────────
{
  const els = Array.from({ length: 6 }, (_, i) => ({
    id: i, role: 'AXStaticText', value: `Sentence number ${i} with real content`, path: `0.5.${i}`,
  }));
  const { elements, removed } = collapseAxElements(els);
  assert.equal(elements.length, 6);
  assert.equal(removed, 0);
}

console.log('ax-collapse: all assertions passed');
