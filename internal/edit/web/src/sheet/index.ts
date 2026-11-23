// Rule sheet: the shown rule's name with file and line, its problems, the
// requirement (edited in place), Reads and Produces with their origins,
// readers, values, and remove buttons, the Add read picker and the Add result
// form. Every structural edit previews before it applies. While a fact is
// held over this rule the pending read shows as a teal "+" row, and a refused
// target explains why, with the cycle as a list. The code pane's root follows
// this one inside #rule-detail.
import type { Result } from '../api';
import { addReadOp } from '../derive';
import { h, holdsFocus, reconcile, setText } from '../dom';
import { beginDrag } from '../drag';
import type { ApplyReply, Diagnostic, Fact, Fix, Op, Rule } from '../protocol';
import type { Region } from '../region';
import { diagnosticsFor, pendingRead, shownRule, type State } from '../store';
import { applyAndSettle, failureText, fixButton, plainKey, previewWhileAimed, typingTarget } from '../widgets/actions';
import { combobox, type Combobox } from '../widgets/combobox';
import { inlineConfirm, inlineName, submitOnEnter, uniqueId } from '../widgets/inline';
import { factNameProblem, modelTypes, requirementIsEmpty, ruleNameProblem, typeProblem, withLeadingName } from '../widgets/names';
import { originText, readOptions } from '../widgets/pickers';

type Kind = 'read' | 'produce';
/** One row of Reads or Produces. `pending` would be added by the previewed op, `removing` removed by it. */
type RowData = { kind: Kind; fact: Fact; pending: boolean; removing: boolean };
type RowParts = {
  button: HTMLButtonElement; name: HTMLElement; type: HTMLElement; value: HTMLElement;
  remove: HTMLButtonElement; origin: HTMLElement; problems: HTMLElement;
};

const parts = new WeakMap<HTMLElement, RowParts>();

/** Detail of the 'infergo:add-read' event the graph dispatches for its A key. */
export type AddReadRequest = { rule: string };

export const mount: Region = (root, store, shell) => {
  const unsupportedId = uniqueId('sheet-unsupported');
  const typesId = uniqueId('sheet-types');
  const title = h('h2', { class: 'sheet-name', tabindex: '-1' });
  const rename = h('button', { type: 'button', class: 'mini', 'aria-keyshortcuts': 'F2' }, 'Rename');
  const remove = h('button', { type: 'button', class: 'mini' }, 'Delete rule');
  const where = h('span', { class: 'mono sheet-where' });
  const actions = h('span', { class: 'sheet-actions' }, rename, remove);
  const titleRow = h('div', { class: 'sheet-title' }, title, actions, where);
  const titleHost = h('div', { class: 'sheet-title-host' });
  const stateLine = h('p', { class: 'sheet-state' });
  const gesture = h('div', { class: 'sheet-gesture' });
  const unsupported = h('p', { class: 'row-warning sheet-unsupported', id: unsupportedId, hidden: true });
  const problems = h('ul', { class: 'sheet-problems', 'aria-label': 'Problems' });
  const requirement = h('div', { class: 'sheet-requirement', role: 'button', tabindex: '0', title: 'Click or press Enter to edit' });
  const requirementHost = h('div');
  const readsId = uniqueId('sheet-reads');
  const producesId = uniqueId('sheet-produces');
  const reads = h('ul', { class: 'sheet-rows', 'aria-labelledby': readsId });
  const produces = h('ul', { class: 'sheet-rows', 'aria-labelledby': producesId });
  const addRead = h('button', { type: 'button', class: 'link sheet-add', 'aria-keyshortcuts': 'A', 'aria-expanded': 'false' }, 'Add read');
  const readHost = h('div', { class: 'sheet-host' });
  const addResult = h('button', { type: 'button', class: 'link sheet-add', 'aria-expanded': 'false' }, 'Add result');
  const resultHost = h('div', { class: 'sheet-host' });
  const types = h('datalist', { id: typesId });
  root.append(
    titleRow, titleHost, stateLine, unsupported, problems, gesture, requirement, requirementHost,
    h('h3', { class: 'section-heading', id: readsId }, 'Reads'), reads, addRead, readHost,
    h('h3', { class: 'section-heading', id: producesId }, 'Produces'), produces, addResult, resultHost, types,
  );

  // The rule the open editors were opened for. An editor closes when the sheet moves to another rule, unless it holds focus.
  let current: Rule | undefined;
  let picker: { rule: string; box: Combobox; opener?: HTMLElement } | undefined;
  // `busy` while its operation is in flight: a rename changes the shown rule's id and may move the detail, and that must not close it.
  let open: { rule: string; close(): void; element: HTMLElement; busy?: boolean } | undefined;

  const structuralOff = () => !!current?.unsupported;
  const focusTitle = () => title.focus();

  const rowButton = (list: HTMLElement, fact: string) =>
    list.querySelector<HTMLLIElement>(`:scope > li[data-key="${CSS.escape(fact)}"]`)?.querySelector<HTMLButtonElement>('button.sheet-fact') ?? undefined;

  // The row to focus after `fact` leaves `list`: the next one, else the previous, else the Add control.
  const neighbourAfterRemoval = (list: HTMLElement, fact: string, fallback: HTMLElement) => {
    const keys = [...list.children].map(li => (li as HTMLElement).dataset.key!).filter(key => !key.startsWith('+'));
    const at = keys.indexOf(fact);
    const next = keys[at + 1] ?? keys[at - 1];
    return () => (next && rowButton(list, next) ? rowButton(list, next)!.focus() : fallback.focus());
  };

  const opFor = (kind: Kind, fact: string): Op | undefined =>
    current ? (kind === 'read' ? { op: 'remove_read', rule: current.id, fact } : { op: 'remove_produce', rule: current.id, fact }) : undefined;

  async function removeRow(kind: Kind, fact: string) {
    const op = opFor(kind, fact);
    if (!op || structuralOff()) return;
    const list = kind === 'read' ? reads : produces;
    const refocus = neighbourAfterRemoval(list, fact, kind === 'read' ? addRead : addResult);
    const result = await applyAndSettle(store, op);
    if (result.kind === 'ok') refocus();
  }

  // ---- Rows -------------------------------------------------------------

  function createRow(kind: Kind, fact: string): HTMLElement {
    const name = h('span', { class: 'fact-name' });
    const type = h('span', { class: 'fact-type' });
    const button = h('button', { type: 'button', class: 'sheet-fact fact-row', 'aria-keyshortcuts': 'W Delete' }, name, type);
    const value = h('span', { class: 'sheet-value' });
    const removeButton = h('button', { type: 'button', class: 'mini sheet-remove' }, '×');
    const origin = h('div', { class: 'sheet-origin' });
    const rowProblems = h('ul', { class: 'sheet-row-problems' });
    const li = h('li', {}, h('div', { class: 'sheet-line' }, button, value, removeButton), origin, rowProblems);
    parts.set(li, { button, name, type, value, remove: removeButton, origin, problems: rowProblems });

    if (fact.startsWith('+')) { button.tabIndex = -1; removeButton.hidden = true; return li; }
    previewWhileAimed(removeButton, store, () => (structuralOff() ? undefined : opFor(kind, fact)));
    removeButton.addEventListener('click', () => void removeRow(kind, fact));
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      if (store.state.held?.fact.name === fact) { store.cancel(); return; }
      beginDrag(event, fact, store);
    });
    button.addEventListener('click', event => { if (event.detail === 0) toggleHold(fact); });
    button.addEventListener('keydown', event => {
      if (!plainKey(event)) return;
      if (event.key === 'w' || event.key === 'W' || event.key === 'Enter') { event.preventDefault(); toggleHold(fact); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void removeRow(kind, fact); }
    });
    for (const type of ['pointerenter', 'focus'] as const) button.addEventListener(type, () => store.highlight(fact));
    for (const type of ['pointerleave', 'blur'] as const) {
      button.addEventListener(type, () => { if (store.state.highlight === fact) store.highlight(undefined); });
    }
    return li;
  }

  const toggleHold = (fact: string) => {
    if (store.state.held?.fact.name === fact) store.cancel();
    else store.hold(fact);
  };

  function updateRow(li: HTMLElement, row: RowData, state: State, rule: Rule) {
    const p = parts.get(li)!;
    const held = !row.pending && state.held?.fact.name === row.fact.name;
    li.classList.toggle('pending', row.pending);
    li.classList.toggle('removing', row.removing);
    li.classList.toggle('lit', state.highlight === row.fact.name || held);
    const prefix = row.pending ? '+ ' : row.removing ? '− ' : '';
    setText(p.name, `${prefix}${row.fact.name}`);
    setText(p.type, row.fact.type);
    setText(p.value, valueOf(state, row.fact.name) ?? '');
    const errors = rowDiagnostics(state, rule, row.fact.name);
    p.name.classList.toggle('text-error', errors.some(diagnostic => diagnostic.severity === 'error'));
    p.button.setAttribute('aria-pressed', String(held));
    p.button.setAttribute('aria-label', `${row.kind === 'read' ? 'Reads' : 'Produces'} ${row.fact.name} ${row.fact.type}${row.pending ? ', would be added' : ''}${row.removing ? ', would be removed' : ''}${held ? ', held' : ''}`);
    p.remove.setAttribute('aria-label', `${row.kind === 'read' ? 'Remove read' : 'Remove result'} ${row.fact.name}`);
    p.remove.hidden = row.pending;
    disable(p.remove, !!rule.unsupported);

    // Origin: the producers as links for a read, readers as links for a result.
    if (!holdsFocus(p.origin)) {
      const info = state.graph.facts.get(row.fact.name);
      const items: (Node | string)[] = [];
      if (row.kind === 'read') {
        const producers = info?.producers ?? [];
        if (producers.length) producers.forEach((id, index) => items.push(...(index ? [', '] : []), ruleLink(id, `← ${id}()`)));
        else items.push(originText(state.graph, row.fact.name));
      } else {
        const readers = info?.readers ?? [];
        if (info?.requested) items.push('Requested output');
        if (readers.length) {
          items.push(info?.requested ? ' · read by ' : 'Read by ');
          readers.forEach((id, index) => items.push(...(index ? [', '] : []), ruleLink(id, `${id}()`)));
        } else if (!info?.requested) items.push(row.pending ? 'Not read by any rule yet' : 'Not read by any rule');
      }
      p.origin.replaceChildren(...items);
    }
    renderDiagnostics(p.problems, errors, () => (rowButton(row.kind === 'read' ? reads : produces, row.fact.name) ?? title).focus());
  }

  function ruleLink(id: string, label: string): HTMLButtonElement {
    const link = h('button', { type: 'button', class: 'link' }, label);
    link.addEventListener('click', () => {
      store.select({ rule: id });
      focusTitle();
    });
    return link;
  }

  // Diagnostics as rows with their message and fix links. A fix moves focus to `after` once it lands.
  function renderDiagnostics(list: HTMLElement, diagnostics: Diagnostic[], after: () => void) {
    reconcile(list, diagnostics, diagnosticKey, diagnostic => {
      const li = h('li', { class: diagnostic.severity === 'error' ? 'row-error' : 'row-warning' },
        h('span', { class: 'sheet-problem-text' }, diagnostic.message));
      if (diagnostic.fixes.length) li.append(h('span', { class: 'fixes' }, ...diagnostic.fixes.map(fix => fixButton(store, fix, settledFocus(after)))));
      return li;
    }, () => undefined);
    list.hidden = !diagnostics.length;
  }

  // After a fix applied, move focus off the link if the next check will remove it.
  const settledFocus = (after: () => void) => (result: Result<ApplyReply>) => {
    if (result.kind === 'ok') after();
  };

  // ---- Requirement --------------------------------------------------------

  function editRequirement() {
    if (!current || open) return;
    const rule = current;
    const textarea = h('textarea', {
      class: 'sheet-requirement-edit', rows: '2', 'aria-label': `Requirement of ${rule.id}`, 'aria-describedby': uniqueId('req'),
      enterkeyhint: 'done',
    });
    const hint = h('p', { class: 'sheet-hint', id: textarea.getAttribute('aria-describedby')! }, 'Enter saves, Shift Enter adds a line, Esc cancels. The rule name stays the first word.');
    const message = h('p', { class: 'inline-message text-refused' });
    const element = h('div', { class: 'sheet-requirement-form' }, textarea, hint, message);
    textarea.value = rule.requirement;
    const grow = () => { textarea.style.height = 'auto'; textarea.style.height = `${textarea.scrollHeight + 2}px`; };
    let done = false;
    const close = (focusBack: boolean) => {
      if (done) return;
      done = true;
      element.remove();
      open = undefined;
      requirement.hidden = false;
      if (focusBack) requirement.focus();
    };
    const save = async (focusBack: boolean) => {
      if (done) return;
      const text = withLeadingName(textarea.value, rule.id);
      if (text === withLeadingName(rule.requirement, rule.id)) { close(focusBack); return; }
      if (requirementIsEmpty(text, rule.id)) {
        message.textContent = `Write what ${rule.id} does after its name.`;
        shell.announce(message.textContent);
        if (!focusBack) close(false);
        return;
      }
      const refusal = failureText(await applyAndSettle(store, { op: 'set_requirement', rule: rule.id, text }));
      if (refusal && focusBack) { message.textContent = refusal; textarea.focus(); return; }
      close(focusBack);
    };
    textarea.addEventListener('input', () => { grow(); message.textContent = ''; });
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void save(true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    });
    textarea.addEventListener('blur', () => { if (!done) void save(false); });
    requirement.hidden = true;
    requirementHost.append(element);
    open = { rule: rule.id, element, close: () => close(false) };
    grow();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }
  requirement.addEventListener('click', editRequirement);
  requirement.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    editRequirement();
  });

  // ---- Rename and delete the rule -----------------------------------------

  function renameRule() {
    if (!current || open) return;
    const rule = current;
    const form = inlineName({
      label: `Rename rule ${rule.id}`,
      value: rule.id,
      action: 'Rename',
      validate: value => ruleNameProblem(value, store.state.graph, rule.id),
      submit: async value => {
        if (open) open.busy = true;
        const refusal = failureText(await applyAndSettle(store, { op: 'rename_rule', rule: rule.id, to: value }));
        if (open) open.busy = false;
        return refusal;
      },
      announce: text => shell.announce(text),
      closed: how => {
        open = undefined;
        titleRow.hidden = false;
        if (how === 'applied') focusTitle();
        else if (how !== 'left') rename.focus();
      },
    });
    titleRow.hidden = true;
    titleHost.append(form.element);
    open = { rule: rule.id, element: form.element, close: form.close };
    form.input.focus();
    form.input.select();
  }
  rename.addEventListener('click', renameRule);

  function deleteRule() {
    if (!current || open) return;
    const rule = current;
    const op: Op = { op: 'delete_rule', rule: rule.id };
    const confirm = inlineConfirm({
      question: `Delete ${rule.id}? Its doc comment and declaration are removed from ${rule.file}.`,
      confirm: `Delete ${rule.id}`,
      decorate: button => previewWhileAimed(button, store, () => op),
      submit: async () => failureText(await applyAndSettle(store, op)),
      announce: text => shell.announce(text),
      closed: how => {
        open = undefined;
        actions.hidden = false;
        store.clearPreview(op);
        if (how === 'applied') focusTitle();
        else remove.focus();
      },
    });
    actions.hidden = true;
    titleHost.append(confirm.element);
    open = { rule: rule.id, element: confirm.element, close: confirm.close };
    confirm.focus();
  }
  remove.addEventListener('click', deleteRule);

  // ---- Add read -----------------------------------------------------------

  function openAddRead(opener?: HTMLElement) {
    if (!current || structuralOff()) {
      if (current?.unsupported) shell.announce(current.unsupported);
      return;
    }
    if (picker) { picker.box.input.focus(); return; }
    const rule = current.id;
    let previewed: Op | undefined;
    let added: string | undefined;
    const box = combobox({
      label: `Add read to ${rule}`,
      placeholder: 'Fact name or type',
      empty: 'No fact matches.',
      options: query => readOptions(store.state.graph, rule, query)
        .map(option => ({ key: option.fact, name: option.fact, type: option.type, note: option.reason ?? option.origin, disabled: !!option.reason })),
      active: option => {
        if (option) { previewed = addReadOp(store.state.graph, option.key, rule); store.previewOp(previewed); }
        else if (previewed) { store.clearPreview(previewed); previewed = undefined; }
      },
      choose: async option => {
        added = option.key;
        return failureText(await applyAndSettle(store, addReadOp(store.state.graph, option.key, rule)));
      },
      announce: text => shell.announce(text),
      closed: how => {
        const back = picker?.opener;
        picker = undefined;
        addRead.hidden = false;
        addRead.setAttribute('aria-expanded', 'false');
        if (how === 'chosen' && added && rowButton(reads, added)) { rowButton(reads, added)!.focus(); return; }
        if (how === 'left') return;
        (back?.isConnected ? back : addRead).focus();
      },
    });
    picker = { rule, box, opener };
    addRead.hidden = true;
    addRead.setAttribute('aria-expanded', 'true');
    readHost.append(box.element);
    box.input.focus();
  }
  addRead.addEventListener('click', () => openAddRead(addRead));
  document.addEventListener('infergo:add-read', event => {
    const detail = (event as CustomEvent<AddReadRequest>).detail;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (detail?.rule && store.state.graph.rules.has(detail.rule) && store.state.selection.rule !== detail.rule) store.select({ rule: detail.rule });
    if (store.state.collapsed.rule && !store.state.narrow) store.toggleColumn('rule');
    picker?.box.close();
    openAddRead(opener);
  });

  // ---- Add result ---------------------------------------------------------

  function openAddResult() {
    if (current?.unsupported) { shell.announce(current.unsupported); return; }
    if (!current || open) return;
    const rule = current.id;
    const nameId = uniqueId('result-name');
    const typeId = uniqueId('result-type');
    const name = h('input', { id: nameId, type: 'text', class: 'mono', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    const type = h('input', { id: typeId, type: 'text', class: 'mono', list: typesId, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'uint64' });
    const message = h('p', { class: 'inline-message text-refused', id: uniqueId('result-message') });
    name.setAttribute('aria-describedby', message.id);
    const cancel = h('button', { type: 'button', class: 'mini' }, 'Cancel');
    const form = h('form', { class: 'sheet-form', novalidate: true, 'aria-label': `Add a result to ${rule}` },
      h('div', { class: 'sheet-pair' },
        h('div', {}, h('label', { for: nameId }, 'Result name'), name),
        h('div', {}, h('label', { for: typeId }, 'Go type'), type)),
      h('span', { class: 'inline-actions' }, h('button', { type: 'submit', class: 'mini' }, 'Add result'), cancel), message);
    submitOnEnter(type, form);
    let previewed: Op | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valid = () => !factNameProblem(name.value.trim(), store.state.graph) && !typeProblem(type.value.trim());
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (previewed) store.clearPreview(previewed);
        previewed = valid() ? { op: 'add_produce', rule, fact: name.value.trim(), type: type.value.trim() } : undefined;
        if (previewed) store.previewOp(previewed);
      }, 150);
    };
    const close = (focus: HTMLElement | undefined) => {
      clearTimeout(timer);
      if (previewed) store.clearPreview(previewed);
      form.remove();
      open = undefined;
      addResult.hidden = false;
      addResult.setAttribute('aria-expanded', 'false');
      focus?.focus();
    };
    name.addEventListener('input', () => { message.textContent = ''; refresh(); });
    type.addEventListener('input', () => { message.textContent = ''; refresh(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const fact = name.value.trim();
      const goType = type.value.trim();
      const problem = factNameProblem(fact, store.state.graph) ?? typeProblem(goType);
      if (problem) { message.textContent = problem; shell.announce(problem); return; }
      clearTimeout(timer);
      if (previewed) store.clearPreview(previewed);
      previewed = undefined;
      const refusal = failureText(await applyAndSettle(store, { op: 'add_produce', rule, fact, type: goType }));
      if (refusal) { message.textContent = refusal; return; }
      close(undefined);
      (rowButton(produces, fact) ?? addResult).focus();
    });
    form.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(addResult);
    });
    cancel.addEventListener('click', () => close(addResult));
    addResult.hidden = true;
    addResult.setAttribute('aria-expanded', 'true');
    resultHost.append(form);
    open = { rule, element: form, close: () => close(undefined) };
    name.focus();
  }
  addResult.addEventListener('click', openAddResult);

  // ---- Keys ---------------------------------------------------------------

  root.addEventListener('keydown', event => {
    if (event.defaultPrevented || !plainKey(event) || typingTarget(event.target)) return;
    if (event.key === 'F2') { event.preventDefault(); renameRule(); }
    else if (event.key === 'a' || event.key === 'A') { event.preventDefault(); openAddRead(event.target instanceof HTMLElement ? event.target : undefined); }
  });

  // ---- Render -------------------------------------------------------------

  store.watch(s => [shownRule(s), s.held, s.preview, s.check, s.highlight, s.graph, s.values, s.scenario], () => {
    const state = store.state;
    const rule = shownRule(state);
    root.hidden = !rule;
    if (!rule) { current = undefined; return; }
    if (current?.id !== rule.id) {
      if (open && open.rule !== rule.id && !open.busy && !holdsFocus(open.element)) open.close();
      if (picker && picker.rule !== rule.id && !holdsFocus(picker.box.element)) picker.box.close();
    }
    current = rule;
    types.replaceChildren(...modelTypes(state.model).map(type => h('option', { value: type })));

    setText(title, `${rule.id}()`);
    setText(where, `${rule.file}:${rule.line}`);
    renderState(stateLine, state, rule);
    renderGesture(gesture, state, rule.id);

    unsupported.hidden = !rule.unsupported;
    setText(unsupported, rule.unsupported ? `Structural edits are off for this rule: ${rule.unsupported}` : '');
    for (const control of [addRead, addResult]) disable(control, !!rule.unsupported);
    for (const control of [addRead, addResult]) {
      if (rule.unsupported) control.setAttribute('aria-describedby', unsupportedId);
      else control.removeAttribute('aria-describedby');
    }

    if (!open || open.element.parentElement !== requirementHost) {
      setText(requirement, rule.requirement || 'No requirement written. Click to write one.');
      requirement.setAttribute('aria-label', `Requirement: ${rule.requirement || 'none written'}. Press Enter to edit.`);
    }

    renderDiagnostics(problems, ruleDiagnostics(state, rule), focusTitle);

    const op = state.preview?.op;
    const pendingProduce = op?.op === 'add_produce' && op.rule === rule.id ? { name: op.fact, type: op.type } : undefined;
    const pending = pendingRead(state, rule.id);
    const removes = (kind: Kind, fact: string) => op?.op === (kind === 'read' ? 'remove_read' : 'remove_produce') && op.rule === rule.id && op.fact === fact;
    const readRows: RowData[] = [
      ...rule.reads.map(fact => ({ kind: 'read' as const, fact, pending: false, removing: removes('read', fact.name) })),
      ...(pending ? [{ kind: 'read' as const, fact: pending, pending: true, removing: false }] : []),
    ];
    const produceRows: RowData[] = [
      ...rule.produces.map(fact => ({ kind: 'produce' as const, fact, pending: false, removing: removes('produce', fact.name) })),
      ...(pendingProduce ? [{ kind: 'produce' as const, fact: pendingProduce, pending: true, removing: false }] : []),
    ];
    const key = (row: RowData) => `${row.pending ? '+' : ''}${row.fact.name}`;
    reconcile(reads, readRows, key, row => createRow('read', key(row)), (li, row) => updateRow(li, row, state, rule));
    reconcile(produces, produceRows, key, row => createRow('produce', key(row)), (li, row) => updateRow(li, row, state, rule));
    picker?.box.refresh();
  });
};

// Problem count, pruned note, or the gesture's state, under the title.
function renderState(line: HTMLElement, state: State, rule: Rule) {
  const held = state.held;
  let text = '';
  let tone = '';
  if (held && held.over === rule.id && held.verdict) {
    if (!held.verdict.ok) { text = `Can't take ${held.fact.name}. Nothing changes.`; tone = 'text-refused'; }
    else if (state.preview?.state === 'refused') { text = state.preview.refusal.message; tone = 'text-refused'; }
    else if (state.preview?.state === 'failed') { text = state.preview.error; tone = 'text-error'; }
    else { text = 'Preview. Nothing is written until you drop.'; tone = 'text-teal'; }
  } else if (state.preview && 'rule' in state.preview.op && state.preview.op.rule === rule.id) {
    if (state.preview.state === 'refused') { text = `Not possible: ${state.preview.refusal.message}`; tone = 'text-refused'; }
    else { text = 'Preview. Nothing is written yet.'; tone = 'text-teal'; }
  } else {
    const diagnostics = diagnosticsFor(state, { rule: rule.id }).filter(diagnostic => diagnostic.kind !== 'unused_rule');
    const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error').length;
    const warnings = diagnostics.length - errors;
    const counts = [errors && `${errors} ${errors === 1 ? 'error' : 'errors'}`, warnings && `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`].filter(Boolean);
    if (counts.length) { text = counts.join(' · '); tone = errors ? 'text-error' : 'text-warning'; }
    else if (rule.stub) text = 'Stub. It returns an error until you write the body.';
  }
  // The line keeps its height when empty, so a preview appearing on hover does not move the row under the pointer.
  setText(line, text);
  line.className = `sheet-state ${tone}`;
}

function renderGesture(target: HTMLElement, state: State, rule: string) {
  const held = state.held;
  const verdict = held?.over === rule ? held.verdict : undefined;
  if (!held || !verdict || verdict.ok) { if (target.childElementCount) target.replaceChildren(); return; }
  const key = `${held.fact.name}>${rule}>${verdict.reason}`;
  if (target.dataset.key === key && target.childElementCount) return;
  target.dataset.key = key;
  if (verdict.reason !== 'cycle') {
    const why = verdict.reason === 'reads' ? `${rule} already reads ${held.fact.name}.`
      : verdict.reason === 'produces' ? `${rule} produces ${held.fact.name}.`
        : state.graph.rules.get(rule)?.unsupported ?? `${rule} cannot be edited here.`;
    target.replaceChildren(h('div', { class: 'row-refused' }, h('p', {}, why)));
    return;
  }
  const steps = [...verdict.wires.map(wire => `${wire.from} → ${wire.fact}`), `${verdict.path.at(-1)} → ${held.fact.name}`, rule];
  target.replaceChildren(h('div', { class: 'row-refused' },
    h('p', {}, `${held.fact.name} already depends on ${rule}:`),
    h('ol', { class: 'sheet-cycle mono', 'aria-label': 'The cycle this read would close' }, ...steps.map(step => h('li', {}, step))),
    h('p', {}, 'Remove one of these wires first, then drop again.')));
}

function diagnosticKey(diagnostic: Diagnostic): string {
  return [diagnostic.kind, diagnostic.rule ?? '', diagnostic.fact ?? '', diagnostic.line ?? '', diagnostic.message].join('|');
}

/** Diagnostics drawn on one row: those that name the fact and this rule. */
function rowDiagnostics(state: State, rule: Rule, fact: string): Diagnostic[] {
  return diagnosticsFor(state, { rule: rule.id, fact }).filter(diagnostic => diagnostic.kind !== 'unused_rule');
}

/** Diagnostics drawn under the name: those about this rule that name none of its rows, and the pruned note. */
function ruleDiagnostics(state: State, rule: Rule): Diagnostic[] {
  const facts = new Set([...rule.reads, ...rule.produces].map(fact => fact.name));
  const list = diagnosticsFor(state, { rule: rule.id })
    .filter(diagnostic => diagnostic.kind !== 'unused_rule' && !(diagnostic.fact && facts.has(diagnostic.fact)));
  if (state.check?.pruned.includes(rule.id)) {
    const reported = diagnosticsFor(state, { rule: rule.id }).find(diagnostic => diagnostic.kind === 'unused_rule');
    const output = rule.produces[0];
    const fixes: Fix[] = reported?.fixes ?? [
      ...(output ? [{ label: `Request ${output.name} as an output`, op: { op: 'set_requested', fact: output.name, requested: true } } satisfies Fix] : []),
      { label: `Delete ${rule.id}`, op: { op: 'delete_rule', rule: rule.id } },
    ];
    list.push({ severity: 'warning', kind: 'unused_rule', rule: rule.id, message: 'Not needed by any requested output.', fixes });
  }
  return list;
}

/** The value of a fact in the selected scenario, when values are on. */
function valueOf(state: State, fact: string): string | undefined {
  const cases = state.values?.cases;
  if (!cases?.length) return undefined;
  const snapshot = cases.find(item => item.id === state.scenario) ?? cases[0]!;
  if (fact in snapshot.inputs) return snapshot.inputs[fact];
  for (const trace of snapshot.trace) if (trace.facts && fact in trace.facts) return trace.facts[fact];
  return undefined;
}

// Structural controls stay focusable when off, so their reason (aria-describedby) is read.
function disable(control: HTMLButtonElement, off: boolean) {
  control.setAttribute('aria-disabled', String(off));
  control.classList.toggle('off', off);
}
