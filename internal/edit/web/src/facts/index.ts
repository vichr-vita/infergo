// Facts column: Inputs, Outputs, and Derived facts, each row a fact and its
// type, filtered by Find. Every row is a pick up source: a press starts a
// drag (beginDrag), W or Enter holds it from the keyboard, and pressing the
// held row again puts it down. F2 renames a fact in place. Inputs can be
// added and removed; Outputs take a dropped fact or a pick from a combobox,
// and can be removed. Each list is one tab stop with arrow keys inside it.
import type { FactInfo } from '../derive';
import { h, holdsFocus, reconcile, setText } from '../dom';
import { beginDrag } from '../drag';
import type { ZoneDrop } from '../drag';
import type { Contract, Diagnostic, Op } from '../protocol';
import type { Region } from '../region';
import { matchesQuery, type State } from '../store';
import { applyAndSettle, failureText, fixButton, plainKey, previewWhileAimed } from '../widgets/actions';
import { combobox, type Combobox } from '../widgets/combobox';
import { inlineName, uniqueId } from '../widgets/inline';
import { factNameProblem, modelTypes, typeProblem } from '../widgets/names';
import { requestOptions } from '../widgets/pickers';

type SectionKey = 'inputs' | 'outputs' | 'derived';

type Section = {
  key: SectionKey;
  title: string;
  wrapper: HTMLElement;
  count: HTMLElement;
  add?: HTMLButtonElement;
  host: HTMLElement; // where the add form or picker opens
  hint: HTMLElement; // "+ Drop to request x" while a fact is held
  note: HTMLElement; // why the contract is read-only
  list: HTMLUListElement;
};

type Row = {
  li: HTMLElement;
  button: HTMLButtonElement;
  name: HTMLElement;
  held: HTMLElement;
  type: HTMLElement;
  remove?: HTMLButtonElement;
  problem: HTMLElement;
};

const rows = new WeakMap<HTMLElement, Row>();

export const mount: Region = (root, store, shell) => {
  const typesId = uniqueId('fact-types');
  const types = h('datalist', { id: typesId });
  root.append(types);

  const sections = new Map<SectionKey, Section>();
  for (const [key, title] of [['inputs', 'Inputs'], ['outputs', 'Outputs'], ['derived', 'Derived']] as const) {
    const count = h('span', { class: 'count' });
    const headingId = uniqueId(`facts-${key}`);
    const add = key === 'derived' ? undefined : h('button', {
      type: 'button', class: 'mini push', 'aria-label': key === 'inputs' ? 'Add input' : 'Request an output', 'aria-expanded': 'false',
    }, '+');
    const heading = h('h3', { class: 'section-heading', id: headingId }, title, count, add);
    const host = h('div', { class: 'facts-host' });
    const hint = h('p', { class: 'facts-hint pending', hidden: true });
    const note = h('p', { class: 'facts-note', hidden: true });
    const list = h('ul', { class: 'fact-list', 'aria-labelledby': headingId });
    const wrapper = h('section', { class: `facts-section facts-${key}` }, heading, note, host, hint, list);
    root.append(wrapper);
    sections.set(key, { key, title, wrapper, count, add, host, hint, note, list });
  }

  const inputs = sections.get('inputs')!;
  const outputs = sections.get('outputs')!;
  const roving = new Map<HTMLElement, string>();
  let renaming: { section: SectionKey; fact: string } | undefined;
  let openForm: { section: SectionKey; close(): void } | undefined;

  // ---- Focus helpers ------------------------------------------------------

  const rowButton = (section: SectionKey, fact: string) =>
    sections.get(section)!.list.querySelector<HTMLLIElement>(`:scope > li[data-key="${CSS.escape(fact)}"]`)
      ?.querySelector<HTMLButtonElement>('button.fact-row') ?? undefined;

  const focusRow = (section: SectionKey, fact: string) => {
    const button = rowButton(section, fact);
    if (button) { roving.set(sections.get(section)!.list, fact); syncRoving(sections.get(section)!.list); button.focus(); return true; }
    return false;
  };

  // The row to focus after `fact` leaves `section`: the next one, else the previous, else the heading's + button.
  const neighbourAfterRemoval = (section: SectionKey, fact: string) => {
    const list = sections.get(section)!.list;
    const keys = [...list.children].map(li => (li as HTMLElement).dataset.key!);
    const at = keys.indexOf(fact);
    const next = keys[at + 1] ?? keys[at - 1];
    return () => {
      if (next && focusRow(section, next)) return;
      const first = list.querySelector<HTMLButtonElement>('button.fact-row');
      (first ?? sections.get(section)!.add ?? root.closest<HTMLElement>('.column-body') ?? root).focus();
    };
  };

  function syncRoving(list: HTMLElement) {
    const buttons = [...list.querySelectorAll<HTMLButtonElement>(':scope > li > .fact-line > button.fact-row')];
    const key = roving.get(list);
    const chosen = buttons.find(button => button.closest('li')!.dataset.key === key) ?? buttons[0];
    for (const button of buttons) button.tabIndex = button === chosen ? 0 : -1;
  }

  // ---- Operations ---------------------------------------------------------

  const toggleHold = (fact: string) => {
    if (store.state.held?.fact.name === fact) store.cancel();
    else store.hold(fact);
  };

  const removeOp = (section: SectionKey, fact: string): Op | undefined =>
    section === 'inputs' ? { op: 'remove_input', fact } : section === 'outputs' ? { op: 'set_requested', fact, requested: false } : undefined;

  async function removeFact(section: SectionKey, fact: string) {
    const op = removeOp(section, fact);
    if (!op || !contractFor(store.state, section)?.editable) return;
    const refocus = neighbourAfterRemoval(section, fact);
    const result = await applyAndSettle(store, op);
    if (result.kind === 'ok') refocus();
  }

  function openRename(section: SectionKey, fact: string) {
    const li = sections.get(section)!.list.querySelector<HTMLElement>(`:scope > li[data-key="${CSS.escape(fact)}"]`);
    const row = li && rows.get(li);
    if (!row || renaming) return;
    renaming = { section, fact };
    let renamedTo = fact;
    const form = inlineName({
      label: `Rename ${fact}`,
      value: fact,
      action: 'Rename',
      validate: value => factNameProblem(value, store.state.graph, fact),
      submit: async value => {
        renamedTo = value;
        return failureText(await applyAndSettle(store, { op: 'rename_fact', fact, to: value }));
      },
      announce: text => shell.announce(text),
      closed: how => {
        renaming = undefined;
        row.button.hidden = false;
        if (how === 'applied') { if (!focusRow(section, renamedTo)) neighbourAfterRemoval(section, fact)(); }
        else if (how !== 'left' && row.button.isConnected) row.button.focus();
      },
    });
    row.button.hidden = true;
    row.li.querySelector('.fact-line')!.after(form.element);
    form.input.focus();
    form.input.select();
  }

  // ---- Rows ---------------------------------------------------------------

  function createRow(section: SectionKey, fact: string): HTMLElement {
    const name = h('span', { class: 'fact-name' });
    const held = h('span', { class: 'fact-held', hidden: true }, 'held');
    const type = h('span', { class: 'fact-type' });
    const button = h('button', { type: 'button', class: 'fact-row', 'aria-keyshortcuts': 'W F2' }, name, held, type);
    const line = h('div', { class: 'fact-line' }, button);
    let remove: HTMLButtonElement | undefined;
    if (section !== 'derived') {
      remove = h('button', {
        type: 'button', class: 'mini fact-remove', tabindex: '-1',
        'aria-label': section === 'inputs' ? `Remove input ${fact}` : `Stop requesting ${fact}`,
        title: section === 'inputs' ? 'Remove input' : 'Stop requesting',
      }, '×');
      previewWhileAimed(remove, store, () => removeOp(section, fact));
      remove.addEventListener('click', () => void removeFact(section, fact));
      remove.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft') return;
        event.preventDefault();
        button.focus();
      });
      line.append(remove);
    }
    const problem = h('div', { class: 'row-warning fact-problem', hidden: true });
    const li = h('li', {}, line, problem);
    rows.set(li, { li, button, name, held, type, remove, problem });

    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      if (store.state.held?.fact.name === fact) { store.cancel(); return; }
      beginDrag(event, fact, store);
    });
    // Keyboard activation (Space) arrives as a click with detail 0; a pointer click was handled on pointerdown.
    button.addEventListener('click', event => { if (event.detail === 0) toggleHold(fact); });
    button.addEventListener('keydown', event => {
      const list = sections.get(section)!.list;
      if (!plainKey(event)) return;
      switch (event.key) {
        case 'w': case 'W': case 'Enter':
          event.preventDefault();
          toggleHold(fact);
          return;
        case 'F2':
          event.preventDefault();
          openRename(section, fact);
          return;
        case 'Delete': case 'Backspace':
          if (!removeOp(section, fact)) return;
          event.preventDefault();
          void removeFact(section, fact);
          return;
        case 'ArrowRight':
          if (!remove || remove.hidden) return;
          event.preventDefault();
          remove.focus();
          return;
        case 'ArrowDown': case 'ArrowUp': case 'Home': case 'End': {
          event.preventDefault();
          const buttons = [...list.querySelectorAll<HTMLButtonElement>(':scope > li > .fact-line > button.fact-row:not([hidden])')];
          const at = buttons.indexOf(button);
          const next = event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons.at(-1)
            : buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
          next?.focus();
          return;
        }
      }
    });
    button.addEventListener('focus', () => {
      const list = sections.get(section)!.list;
      roving.set(list, fact);
      syncRoving(list);
      store.highlight(fact);
    });
    button.addEventListener('pointerenter', () => store.highlight(fact));
    for (const type of ['pointerleave', 'blur'] as const) {
      button.addEventListener(type, () => { if (store.state.highlight === fact) store.highlight(undefined); });
    }
    return li;
  }

  function updateRow(section: SectionKey, li: HTMLElement, info: FactInfo, state: State) {
    const row = rows.get(li)!;
    const held = state.held?.fact.name === info.name;
    const editable = !!contractFor(state, section)?.editable;
    setText(row.name, info.name);
    setText(row.type, info.type);
    row.held.hidden = !held;
    row.button.classList.toggle('held', held);
    row.button.setAttribute('aria-pressed', String(held));
    row.button.setAttribute('aria-label', `${info.name} ${info.type}${held ? ', held. Press again to put it down' : ''}`);
    row.button.title = held ? 'Held. Press again to put it down' : 'Press to pick up. F2 renames';
    li.classList.toggle('lit', state.highlight === info.name || held);
    if (!(renaming?.section === section && renaming.fact === info.name)) row.button.hidden = false;
    if (row.remove) row.remove.hidden = !editable;

    const problems = section === 'inputs' ? unusedInput(state, info.name) : [];
    // Computed when rendered, so a fix that removes the row can focus its neighbour.
    const neighbour = neighbourAfterRemoval(section, info.name);
    row.problem.hidden = !problems.length;
    if (!holdsFocus(row.problem)) {
      row.problem.replaceChildren(...problems.map(diagnostic => h('div', {},
        h('span', {}, diagnostic.message),
        diagnostic.fixes.length > 0 && h('span', { class: 'fixes' }, ...diagnostic.fixes.map(fix =>
          fixButton(store, fix, result => { if (result.kind === 'ok' && !row.button.isConnected) neighbour(); }))))));
    }
  }

  // ---- Add input ----------------------------------------------------------

  inputs.add!.addEventListener('click', () => {
    if (openForm?.section === 'inputs') { openForm.close(); return; }
    openForm?.close();
    openAddInput();
  });

  function openAddInput() {
    const nameId = uniqueId('input-name');
    const typeId = uniqueId('input-type');
    const name = h('input', { id: nameId, type: 'text', class: 'mono', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'loyaltyMonths' });
    const type = h('input', { id: typeId, type: 'text', class: 'mono', list: typesId, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'uint64' });
    const message = h('p', { class: 'inline-message text-refused', id: uniqueId('input-message') });
    name.setAttribute('aria-describedby', message.id);
    type.setAttribute('aria-describedby', message.id);
    const cancel = h('button', { type: 'button', class: 'mini' }, 'Cancel');
    const form = h('form', { class: 'facts-form', novalidate: true, 'aria-label': 'Add input' },
      h('label', { for: nameId }, 'Name'), name, h('label', { for: typeId }, 'Go type'), type,
      h('span', { class: 'inline-actions' }, h('button', { type: 'submit', class: 'mini' }, 'Add input'), cancel), message);
    const close = (focusOpener: boolean) => {
      form.remove();
      openForm = undefined;
      inputs.add!.setAttribute('aria-expanded', 'false');
      if (focusOpener) inputs.add!.focus();
    };
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const fact = name.value.trim();
      const goType = type.value.trim();
      const problem = factNameProblem(fact, store.state.graph) ?? typeProblem(goType);
      if (problem) {
        message.textContent = problem;
        shell.announce(problem);
        (factNameProblem(fact, store.state.graph) ? name : type).focus();
        return;
      }
      const refusal = failureText(await applyAndSettle(store, { op: 'add_input', fact, type: goType }));
      if (refusal) { message.textContent = refusal; return; }
      close(false);
      if (!focusRow('inputs', fact)) inputs.add!.focus();
    });
    form.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    });
    cancel.addEventListener('click', () => close(true));
    inputs.host.append(form);
    inputs.add!.setAttribute('aria-expanded', 'true');
    openForm = { section: 'inputs', close: () => close(false) };
    name.focus();
  }

  // ---- Request output -----------------------------------------------------

  let picker: Combobox | undefined;
  outputs.add!.addEventListener('click', () => {
    if (openForm?.section === 'outputs') { openForm.close(); return; }
    openForm?.close();
    let requested: string | undefined;
    picker = combobox({
      label: 'Request an output',
      placeholder: 'Derived fact',
      empty: 'Every derived fact is already requested, or none matches.',
      options: query => requestOptions(store.state.graph, query).map(option => ({ key: option.fact, name: option.fact, type: option.type, note: option.origin })),
      active: () => undefined,
      choose: async option => {
        requested = option.key;
        return failureText(await applyAndSettle(store, { op: 'set_requested', fact: option.key, requested: true }));
      },
      announce: text => shell.announce(text),
      closed: how => {
        picker = undefined;
        openForm = undefined;
        outputs.add!.setAttribute('aria-expanded', 'false');
        if (how === 'chosen' && requested && focusRow('outputs', requested)) return;
        if (how !== 'left') outputs.add!.focus();
      },
    });
    outputs.host.append(picker.element);
    outputs.add!.setAttribute('aria-expanded', 'true');
    openForm = { section: 'outputs', close: () => picker?.close() };
    picker.input.focus();
  });

  outputs.wrapper.dataset.dropZone = 'outputs';
  outputs.wrapper.addEventListener('infergo:drop', event => {
    const { fact } = (event as CustomEvent<ZoneDrop>).detail;
    const info = store.state.graph.facts.get(fact);
    if (!info) return;
    if (info.requested) { shell.announce(`${fact} is already requested.`); return; }
    void applyAndSettle(store, { op: 'set_requested', fact, requested: true });
  });

  // ---- Render -------------------------------------------------------------

  store.watch(s => [s.model, s.graph, s.check, s.query, s.highlight, s.held?.fact.name], () => {
    const state = store.state;
    types.replaceChildren(...modelTypes(state.model).map(type => h('option', { value: type })));
    for (const section of sections.values()) {
      const all = factsIn(state, section.key);
      const shown = all.filter(info => matchesQuery(state, info.name, info.type));
      setText(section.count, String(all.length));
      const contract = contractFor(state, section.key);
      const editable = !contract || contract.editable;
      if (section.add) {
        section.add.hidden = !editable;
        if (!editable && openForm?.section === section.key) openForm.close();
      }
      section.note.hidden = editable;
      if (contract && !editable) {
        setText(section.note, `${contract.type} is declared outside this package, so ${section.key} are read-only here. Change it in your IDE.`);
      }
      reconcile(section.list, shown, info => info.name, info => createRow(section.key, info.name), (li, info) => updateRow(section.key, li, info, state));
      syncRoving(section.list);
    }
    picker?.refresh();

    const held = state.held && state.graph.facts.get(state.held.fact.name);
    const requestable = !!held && held.producers.length > 0 && !held.requested && outputs.add !== undefined && !!state.model.outputs.editable;
    outputs.wrapper.classList.toggle('target', requestable);
    outputs.hint.hidden = !requestable;
    if (requestable) setText(outputs.hint, `+ Drop here to request ${held!.name}`);
  });
};

function contractFor(state: State, section: SectionKey): Contract | undefined {
  return section === 'inputs' ? state.model.inputs : section === 'outputs' ? state.model.outputs : undefined;
}

/** The facts of one section, in the order the contract or the graph lists them. */
function factsIn(state: State, section: SectionKey): FactInfo[] {
  const { graph, model } = state;
  if (section === 'derived') return [...graph.facts.values()].filter(info => info.producers.length);
  const contract = section === 'inputs' ? model.inputs : model.outputs;
  return contract.fields.map(field => graph.facts.get(field.fact)).filter((info): info is FactInfo => !!info);
}

function unusedInput(state: State, fact: string): Diagnostic[] {
  return (state.check?.diagnostics ?? []).filter(diagnostic => diagnostic.kind === 'unused_input' && diagnostic.fact === fact);
}
