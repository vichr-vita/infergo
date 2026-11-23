// List view: the rules as text in dependency order, each with its name,
// requirement, reads, produces, and problem count. It is the layout at
// 1100 px and below and a toggle above it. Below 1100 px the selected item
// opens the rule detail (sheet and code pane) inside itself through
// shell.placeRuleDetail, so every operation is reachable without the canvas.
//
// Items carry data-drop-rule, so the shared pointer wiring aims and drops on
// them. The list is one tab stop: arrows move between items (only through
// valid targets while a fact is held), Enter selects or drops, W picks up the
// rule's result, F2 renames, Delete deletes after an inline confirmation, A
// adds a read, N opens the New rule form.
import { addRuleOp, suggestedResult, verdictMessage } from '../derive';
import { h, reconcile, setText } from '../dom';
import type { Fact, Rule } from '../protocol';
import type { Region } from '../region';
import { diagnosticsFor, matchesQuery, validTargets, type State } from '../store';
import { applyAndSettle, failureText, plainKey, previewWhileAimed, typingTarget } from '../widgets/actions';
import { inlineConfirm, inlineName, uniqueId } from '../widgets/inline';
import { factNameProblem, modelTypes, ruleNameProblem, typeProblem } from '../widgets/names';
import { stepThrough } from './nav';

type Parts = {
  summary: HTMLElement; name: HTMLElement; problems: HTMLElement; requirement: HTMLElement;
  io: HTMLElement; gesture: HTMLElement; host: HTMLElement;
};

export const mount: Region = (root, store, shell) => {
  const hintId = uniqueId('list-hint');
  const typesId = uniqueId('list-types');
  const count = h('span', { class: 'count' });
  const newRule = h('button', { type: 'button', 'aria-keyshortcuts': 'N', 'aria-expanded': 'false' }, 'New rule');
  const canvas = h('button', { type: 'button' }, 'Canvas');
  const formHost = h('div', { class: 'list-form-host' });
  const list = h('ol', { class: 'rule-list', 'aria-label': 'Rules in dependency order', 'aria-describedby': hintId });
  const types = h('datalist', { id: typesId });
  root.append(
    h('div', { class: 'list-heading' }, h('h3', { class: 'section-heading' }, 'Rules', count), h('span', { class: 'list-buttons' }, newRule, canvas)),
    h('p', { class: 'sr-only', id: hintId }, 'Arrow keys move between rules. Enter selects. W picks up the rule’s result, then arrows step through rules that can take it and Enter drops. F2 renames, Delete deletes, A adds a read, N adds a rule.'),
    formHost, list, types,
  );
  canvas.addEventListener('click', () => store.setListView(false));

  const parts = new WeakMap<HTMLElement, Parts>();
  let focusKey: string | undefined;
  let placedIn: HTMLElement | undefined;
  let editing: string | undefined; // rule with an open rename or delete confirmation
  let formOpen: { close(): void } | undefined;

  const item = (id: string) => list.querySelector<HTMLLIElement>(`:scope > li[data-key="${CSS.escape(id)}"]`) ?? undefined;
  const focusItem = (id: string | undefined) => {
    const li = id ? item(id) : undefined;
    if (!li) return false;
    focusKey = id;
    syncRoving();
    li.focus();
    return true;
  };
  const shownIds = () => [...list.children].map(li => (li as HTMLElement).dataset.key!);

  function syncRoving() {
    const items = [...list.children] as HTMLElement[];
    const chosen = items.find(li => li.dataset.key === focusKey) ?? items.find(li => li.dataset.key === store.state.selection.rule) ?? items[0];
    for (const li of items) li.tabIndex = li === chosen ? 0 : -1;
  }

  // ---- Gestures on an item -----------------------------------------------

  async function dropOn(id: string) {
    store.aim(id);
    await store.drop();
    focusItem(id);
  }

  function activate(id: string) {
    if (store.state.held) { void dropOn(id); return; }
    store.select({ rule: id });
  }

  function pickUp(rule: Rule) {
    const fact = rule.produces[0];
    if (!fact) { shell.announce(`${rule.id} produces nothing to pick up.`); return; }
    if (store.state.held?.fact.name === fact.name) store.cancel();
    else store.hold(fact.name);
  }

  function renameInline(id: string) {
    const li = item(id);
    if (!li || editing) return;
    const p = parts.get(li)!;
    editing = id;
    let renamedTo = id;
    const form = inlineName({
      label: `Rename rule ${id}`,
      value: id,
      action: 'Rename',
      validate: value => ruleNameProblem(value, store.state.graph, id),
      submit: async value => {
        renamedTo = value;
        return failureText(await applyAndSettle(store, { op: 'rename_rule', rule: id, to: value }));
      },
      announce: text => shell.announce(text),
      closed: how => {
        editing = undefined;
        if (how === 'applied') { if (!focusItem(renamedTo)) list.focus(); }
        else if (how !== 'left') focusItem(id);
        render();
      },
    });
    p.host.append(form.element);
    form.input.focus();
    form.input.select();
  }

  function deleteInline(id: string) {
    const li = item(id);
    const rule = store.state.graph.rules.get(id);
    if (!li || !rule || editing) return;
    const ids = shownIds();
    const at = ids.indexOf(id);
    const neighbour = ids[at + 1] ?? ids[at - 1];
    editing = id;
    const op = { op: 'delete_rule', rule: id } as const;
    const confirm = inlineConfirm({
      question: `Delete ${id}? Its doc comment and declaration are removed from ${rule.file}.`,
      confirm: `Delete ${id}`,
      decorate: button => previewWhileAimed(button, store, () => op),
      submit: async () => failureText(await applyAndSettle(store, op)),
      announce: text => shell.announce(text),
      closed: how => {
        editing = undefined;
        store.clearPreview(op);
        if (how === 'applied') {
          if (neighbour) store.select({ rule: neighbour });
          if (!focusItem(neighbour)) newRule.focus();
        } else focusItem(id);
        render();
      },
    });
    parts.get(li)!.host.append(confirm.element);
    confirm.focus();
  }

  // ---- New rule -----------------------------------------------------------

  function openNewRule(opener: HTMLElement) {
    if (formOpen) { formOpen.close(); }
    const held = store.state.held?.fact;
    if (held) store.cancel();
    const nameId = uniqueId('new-rule');
    const resultId = uniqueId('new-result');
    const typeId = uniqueId('new-type');
    const name = h('input', { id: nameId, type: 'text', class: 'mono', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'LoyaltyTopUp' });
    const result = h('input', { id: resultId, type: 'text', class: 'mono', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'loyaltyTopUp' });
    const type = h('input', { id: typeId, type: 'text', class: 'mono', list: typesId, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', value: held?.type ?? '', placeholder: 'uint64' });
    const message = h('p', { class: 'inline-message text-refused', id: uniqueId('new-message') });
    for (const input of [name, result, type]) input.setAttribute('aria-describedby', message.id);
    const cancel = h('button', { type: 'button', class: 'mini' }, 'Cancel');
    const form = h('form', { class: 'list-form', novalidate: true, 'aria-label': 'New rule' },
      h('label', { for: nameId }, 'Rule name'), name,
      h('div', { class: 'list-pair' },
        h('div', {}, h('label', { for: resultId }, 'Produces'), result),
        h('div', {}, h('label', { for: typeId }, 'Go type'), type)),
      held ? h('p', { class: 'pending list-reads' }, `+ Reads ${held.name} ${held.type}`) : undefined,
      h('span', { class: 'inline-actions' }, h('button', { type: 'submit', class: 'mini primary' }, 'Create rule'), cancel),
      message);
    let resultEdited = false;
    name.addEventListener('input', () => {
      message.textContent = '';
      if (!resultEdited) result.value = name.value.trim() ? suggestedResult(name.value.trim()) : '';
    });
    result.addEventListener('input', () => { resultEdited = true; message.textContent = ''; });
    type.addEventListener('input', () => { message.textContent = ''; });
    const close = (focus?: HTMLElement) => {
      form.remove();
      formOpen = undefined;
      newRule.setAttribute('aria-expanded', 'false');
      if (focus?.isConnected) focus.focus();
    };
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const graph = store.state.graph;
      const ruleName = name.value.trim();
      const fact = result.value.trim();
      const goType = type.value.trim();
      const problems: [string | undefined, HTMLInputElement][] = [
        [ruleNameProblem(ruleName, graph), name], [factNameProblem(fact, graph), result], [typeProblem(goType), type],
      ];
      const first = problems.find(([problem]) => problem);
      if (first) {
        message.textContent = first[0]!;
        shell.announce(first[0]!);
        first[1].focus();
        return;
      }
      const produces: Fact[] = [{ name: fact, type: goType }];
      const refusal = failureText(await applyAndSettle(store, addRuleOp(graph, ruleName, produces, held)));
      if (refusal) { message.textContent = refusal; return; }
      close();
      store.select({ rule: ruleName });
      if (!focusItem(ruleName)) newRule.focus();
    });
    form.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(opener);
    });
    cancel.addEventListener('click', () => close(opener));
    formHost.append(form);
    newRule.setAttribute('aria-expanded', 'true');
    formOpen = { close: () => close() };
    name.focus();
  }
  newRule.addEventListener('click', () => openNewRule(newRule));

  // ---- Items --------------------------------------------------------------

  function createItem(id: string): HTMLElement {
    const name = h('span', { class: 'rule-name' });
    const problems = h('span', { class: 'rule-problems' });
    const requirement = h('p', { class: 'rule-requirement' });
    const io = h('p', { class: 'rule-io' });
    const gesture = h('p', { class: 'rule-gesture', hidden: true });
    const summary = h('div', { class: 'rule-summary' }, h('div', { class: 'rule-title' }, name, problems), requirement, io, gesture);
    const host = h('div', { class: 'rule-host' });
    const li = h('li', { 'data-drop-rule': id, tabindex: '-1' }, summary, host);
    parts.set(li, { summary, name, problems, requirement, io, gesture, host });

    li.addEventListener('click', event => {
      const target = event.target as Element;
      if (target.closest('.rule-detail, .rule-host')) return;
      activate(id);
      if (document.activeElement !== li) focusItem(id);
    });
    li.addEventListener('pointerenter', () => { if (store.state.held) store.aim(id); });
    li.addEventListener('pointerleave', () => { if (store.state.held?.over === id) store.aim(undefined); });
    li.addEventListener('focus', () => { focusKey = id; syncRoving(); });
    li.addEventListener('keydown', event => {
      if (event.target !== li || !plainKey(event)) return;
      const state = store.state;
      const rule = state.graph.rules.get(id);
      if (!rule) return;
      const move = (to: string | undefined) => {
        if (!to) return;
        if (state.held) store.aim(to);
        focusItem(to);
      };
      const allowed = state.held ? new Set(validTargets(state)) : undefined;
      const from = state.held?.over ?? id;
      switch (event.key) {
        case 'ArrowDown': case 'ArrowUp':
          event.preventDefault();
          move(stepThrough(shownIds(), from, event.key === 'ArrowDown' ? 1 : -1, allowed));
          return;
        case 'Home': case 'End': {
          event.preventDefault();
          const ids = allowed ? shownIds().filter(candidate => allowed.has(candidate)) : shownIds();
          move(event.key === 'Home' ? ids[0] : ids.at(-1));
          return;
        }
        case 'Enter': case ' ':
          event.preventDefault();
          if (state.held) void dropOn(state.held.over ?? id);
          else store.select({ rule: id });
          return;
        case 'w': case 'W':
          event.preventDefault();
          pickUp(rule);
          return;
        case 'F2':
          event.preventDefault();
          renameInline(id);
          return;
        case 'Delete': case 'Backspace':
          event.preventDefault();
          deleteInline(id);
          return;
        case 'a': case 'A':
          event.preventDefault();
          store.select({ rule: id });
          li.dispatchEvent(new CustomEvent('infergo:add-read', { bubbles: true, detail: { rule: id } }));
          return;
      }
    });
    return li;
  }

  function updateItem(li: HTMLElement, rule: Rule, state: State) {
    const p = parts.get(li)!;
    const selected = rule.id === state.selection.rule;
    const verdict = state.held?.verdicts.get(rule.id);
    const aimed = state.held?.over === rule.id;
    const diagnostics = diagnosticsFor(state, { rule: rule.id }).filter(diagnostic => diagnostic.kind !== 'unused_rule');
    const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error').length;
    const warnings = diagnostics.length - errors;
    const pruned = !!state.check?.pruned.includes(rule.id);

    li.classList.toggle('selected', selected);
    li.classList.toggle('target', !!verdict?.ok);
    li.classList.toggle('dim', !!verdict && !verdict.ok);
    li.classList.toggle('aimed', aimed);
    if (selected) li.setAttribute('aria-current', 'true');
    else li.removeAttribute('aria-current');

    setText(p.name, `${rule.id}()`);
    const counts = [errors && `${errors} ${errors === 1 ? 'error' : 'errors'}`, warnings && `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`, pruned && 'not needed by any output'].filter(Boolean).join(' · ');
    setText(p.problems, counts);
    p.problems.className = `rule-problems ${errors ? 'text-error' : warnings || pruned ? 'text-warning' : ''}`;
    setText(p.requirement, rule.requirement || 'No requirement written.');
    const reads = rule.reads.map(fact => fact.name).join(', ') || 'nothing';
    const produces = rule.produces.map(fact => fact.name).join(', ') || 'nothing';
    setText(p.io, `Reads ${reads} → produces ${produces}`);

    const held = state.held;
    let gesture = '';
    let tone = '';
    if (held && aimed && verdict?.ok) { gesture = `+ ${held.fact.name} ${held.fact.type}. Enter or click drops it here`; tone = 'pending'; }
    else if (held && aimed && verdict && !verdict.ok) { gesture = `No drop here. ${verdictMessage(verdict, held.fact.name, rule.id, state.graph)}.`; tone = 'text-refused'; }
    else if (held && verdict?.ok) { gesture = `Can take ${held.fact.name}`; tone = 'text-teal'; }
    setText(p.gesture, gesture);
    p.gesture.className = `rule-gesture ${tone}`;
    p.gesture.hidden = !gesture;

    // On a phone the open item shows the sheet itself, so its own summary steps aside.
    const expanded = state.narrow && selected && !held;
    p.summary.hidden = expanded;
    li.classList.toggle('expanded', expanded);
    const label = [
      `${rule.id}${selected ? ', selected' : ''}`,
      rule.requirement,
      `Reads ${reads}. Produces ${produces}.`,
      counts ? `${counts}.` : 'No problems.',
      gesture,
    ].filter(Boolean).join(' ');
    li.setAttribute('aria-label', label);
  }

  // ---- Keys on the region -------------------------------------------------

  root.addEventListener('keydown', event => {
    if (event.defaultPrevented || !plainKey(event) || typingTarget(event.target)) return;
    if ((event.target as Element).closest('.rule-detail')) return;
    if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      openNewRule(event.target instanceof HTMLElement ? event.target : newRule);
    }
  });

  // ---- Render -------------------------------------------------------------

  function render() {
    const state = store.state;
    canvas.hidden = state.narrow;
    types.replaceChildren(...modelTypes(state.model).map(type => h('option', { value: type })));
    const rules = state.graph.order.map(id => state.graph.rules.get(id)!)
      .filter(rule => rule.id === state.selection.rule
        || matchesQuery(state, rule.id, rule.requirement, ...rule.reads.map(fact => fact.name), ...rule.produces.map(fact => fact.name)));
    setText(count, String(state.graph.rules.size));
    reconcile(list, rules, rule => rule.id, rule => createItem(rule.id), (li, rule) => updateItem(li, rule, state));
    syncRoving();

    // Open the detail under the selected item on a phone. Only when its host changes, because moving it blurs it.
    // A renamed rule gets a new item, so compare elements, not ids.
    const selected = state.narrow && state.layout === 'list' && state.selection.rule ? item(state.selection.rule) : undefined;
    if (selected !== placedIn || (selected && !selected.querySelector(':scope > .rule-detail'))) {
      placedIn = selected;
      shell.placeRuleDetail(selected);
    }
  }

  store.watch(s => [s.graph, s.check, s.query, s.selection.rule, s.held, s.narrow, s.layout], render);
};
