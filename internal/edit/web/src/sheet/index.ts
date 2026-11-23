// Rule sheet. A minimal working stub from workstream E part 1: name, place,
// requirement, reads with remove buttons (hover or focus previews, click
// applies), the pending read while a fact is aimed here, the cycle path for a
// refused aim, produces, and the rule's diagnostics with fix links. E part 2
// replaces this file tree (requirement editing, the Add read combobox).
import { h, holdsFocus, reconcile, setText } from '../dom';
import type { Region } from '../region';
import { diagnosticsFor, pendingRead, shownRule, type State, type Store } from '../store';
import type { Fact, Op } from '../protocol';

type Row = { fact: Fact; pending: boolean };

export const mount: Region = (root, store) => {
  const title = h('h2');
  const where = h('span', { class: 'mono sheet-where' });
  const gesture = h('div', { class: 'sheet-gesture' });
  const requirement = h('p', { class: 'sheet-requirement' });
  const problems = h('ul', { class: 'sheet-problems' });
  const reads = h('ul', { class: 'sheet-rows', 'aria-label': 'Reads' });
  const produces = h('ul', { class: 'sheet-rows', 'aria-label': 'Produces' });
  root.append(
    h('div', { class: 'sheet-title' }, title, where), gesture, requirement, problems,
    h('h3', { class: 'section-heading' }, 'Reads'), reads,
    h('h3', { class: 'section-heading' }, 'Produces'), produces,
  );

  store.watch(s => [shownRule(s), s.held, s.preview, s.check, s.highlight, s.graph], () => {
    const state = store.state;
    const rule = shownRule(state);
    root.hidden = !rule;
    if (!rule) return;
    setText(title, `${rule.id}()`);
    setText(where, `${rule.file}:${rule.line}`);
    setText(requirement, rule.requirement || 'No requirement written.');
    renderGesture(gesture, state, rule.id);

    const pending = pendingRead(state, rule.id);
    const readRows: Row[] = [...rule.reads.map(fact => ({ fact, pending: false })), ...(pending ? [{ fact: pending, pending: true }] : [])];
    reconcile(reads, readRows, row => `${row.pending ? '+' : ''}${row.fact.name}`, row => createRow(store, row), (li, row) => {
      updateRow(li, row, state);
      const producer = state.graph.producers.get(row.fact.name)?.[0];
      setText(li.querySelector('.sheet-origin')!, producer ? `← ${producer}()` : state.graph.facts.get(row.fact.name)?.input ? 'Input' : 'No producer');
      const remove = li.querySelector<HTMLButtonElement>('button.mini');
      if (remove) remove.dataset.rule = rule.id;
    });
    reconcile(produces, rule.produces.map(fact => ({ fact, pending: false })), row => row.fact.name, row => createRow(store, row, false), (li, row) => {
      updateRow(li, row, state);
      const info = state.graph.facts.get(row.fact.name);
      const readers = info?.readers ?? [];
      setText(li.querySelector('.sheet-origin')!, [info?.requested ? 'Requested output' : '', readers.length ? `read by ${readers.map(id => `${id}()`).join(', ')}` : ''].filter(Boolean).join(' · ') || 'Not read');
    });

    const diagnostics = diagnosticsFor(state, { rule: rule.id });
    if (!holdsFocus(problems)) {
      problems.replaceChildren(...diagnostics.map(diagnostic => h('li', { class: diagnostic.severity === 'error' ? 'row-error' : 'row-warning' },
        h('span', {}, diagnostic.message),
        diagnostic.fixes.length > 0 && h('span', { class: 'fixes' }, ...diagnostic.fixes.map(fix => fixButton(store, fix.label, fix.op))))));
    }
  });
};

function renderGesture(target: HTMLElement, state: State, rule: string) {
  const held = state.held;
  if (!held || held.over !== rule || !held.verdict) { target.replaceChildren(); return; }
  if (held.verdict.ok) {
    const preview = state.preview;
    const text = preview?.state === 'refused' ? preview.refusal.message
      : preview?.state === 'failed' ? preview.error : 'Preview. Nothing is written until you drop.';
    target.replaceChildren(h('p', { class: preview?.state === 'refused' || preview?.state === 'failed' ? 'text-refused' : 'text-teal' }, text));
    return;
  }
  const verdict = held.verdict;
  const lines: HTMLElement[] = [h('p', { class: 'text-refused' }, `Can't take ${held.fact.name}. Nothing changes.`)];
  if (verdict.reason === 'cycle') {
    const steps = [...verdict.wires.map(wire => `${wire.from} → ${wire.fact}`), `${verdict.path.at(-1)} → ${held.fact.name}`, rule];
    lines.push(h('div', { class: 'row-refused' },
      h('p', {}, `${held.fact.name} already depends on ${rule}:`),
      h('ol', { class: 'sheet-cycle mono' }, ...steps.map(step => h('li', {}, step))),
      h('p', {}, 'Remove one of these wires first, then drop again.')));
  }
  target.replaceChildren(...lines);
}

function createRow(store: Store, row: Row, removable = true): HTMLElement {
  const li = h('li', {},
    h('span', { class: 'fact-row' }, h('span', { class: 'fact-name' }), h('span', { class: 'fact-type' })),
    h('span', { class: 'sheet-origin' }));
  li.addEventListener('pointerenter', () => store.highlight(row.fact.name));
  li.addEventListener('pointerleave', () => store.highlight(undefined));
  if (removable && !row.pending) {
    const button = h('button', { type: 'button', class: 'mini', 'aria-label': `Remove read ${row.fact.name}` }, '×');
    const op = (): Op => ({ op: 'remove_read', rule: button.dataset.rule ?? '', fact: row.fact.name });
    for (const type of ['pointerenter', 'focus']) button.addEventListener(type, () => store.previewOp(op()));
    for (const type of ['pointerleave', 'blur']) button.addEventListener(type, () => store.clearPreview(op()));
    button.addEventListener('click', () => { store.clearPreview(op()); void store.apply(op()); });
    li.append(button);
  }
  return li;
}

function updateRow(li: HTMLElement, row: Row, state: State) {
  li.classList.toggle('pending', row.pending);
  li.classList.toggle('lit', state.highlight === row.fact.name);
  setText(li.querySelector('.fact-name')!, `${row.pending ? '+ ' : ''}${row.fact.name}`);
  setText(li.querySelector('.fact-type')!, row.fact.type);
}

function fixButton(store: Store, label: string, op: Op) {
  const button = h('button', { type: 'button', class: 'fix' }, label);
  for (const type of ['pointerenter', 'focus']) button.addEventListener(type, () => store.previewOp(op));
  for (const type of ['pointerleave', 'blur']) button.addEventListener(type, () => store.clearPreview(op));
  button.addEventListener('click', () => { store.clearPreview(op); void store.apply(op); });
  return button;
}
