// The page shell. start() loads the model through the given Api, mounts the
// six regions, and owns what sits outside them: the header, the summary line,
// the status line, the left column's tabs, column collapsing, the live region,
// the keys overlay, and the global keys. boot.ts calls it with the server Api,
// dev.ts with the mock.
import type { Api } from './api';
import { mount as mountCode } from './code/index';
import { mount as mountFacts } from './facts/index';
import { mount as mountGraph } from './graph/index';
import { mount as mountHistory } from './history/index';
import { mount as mountList } from './list/index';
import { mount as mountSheet } from './sheet/index';
import { verdictMessage } from './derive';
import { h, holdsFocus, setText } from './dom';
import type { Region, Shell } from './region';
import { canRedo, canUndo, checkPending, problemCounts, validTargets, Store, type State } from './store';

/** Width at or below which the page switches to one column and the list view. Matches the viewer. */
const narrowQuery = '(max-width: 1100px)';

function required<T extends Element>(selector: string, type: { new(...args: never[]): T }): T {
  const node = document.querySelector(selector);
  if (!(node instanceof type)) throw new Error(`Missing editor element: ${selector}`);
  return node;
}

export async function start(api: Api): Promise<Store | undefined> {
  const boot = required('#boot', HTMLElement);
  const connected = await Store.connect(api);
  if (connected.kind !== 'ok') {
    const reason = connected.kind === 'refused' ? connected.refusal.message : connected.error;
    const retry = h('button', { type: 'button' }, 'Retry');
    retry.addEventListener('click', () => location.reload());
    boot.replaceChildren(h('span', { class: 'text-error' }, `The ruleset could not be loaded. ${reason}`), ' ', retry);
    return undefined;
  }
  const store = connected.value;
  const app = required('#app', HTMLElement);
  const announcer = required('#announcer', HTMLElement);
  const workspace = required('#workspace', HTMLElement);
  const ruleColumn = required('#rule-column', HTMLElement);
  const ruleBody = required('#rule-column .column-body', HTMLElement);
  const detail = required('#rule-detail', HTMLElement);

  let detailHost: HTMLElement | undefined;
  const shell: Shell = {
    announce(text) {
      // Clearing first makes a repeated message be spoken again.
      announcer.textContent = '';
      requestAnimationFrame(() => { announcer.textContent = text; });
    },
    placeRuleDetail(host) {
      if (host === detailHost && detail.parentElement === (host ?? ruleBody)) return;
      detailHost = host;
      (host ?? ruleBody).append(detail);
      ruleColumn.hidden = !!host;
    },
  };

  const regions: [string, Region][] = [
    ['facts', mountFacts], ['history', mountHistory], ['graph', mountGraph],
    ['list', mountList], ['sheet', mountSheet], ['code', mountCode],
  ];
  for (const [name, mount] of regions) mount(required(`[data-region="${name}"]`, HTMLElement), store, shell);

  renderHeader(store);
  renderSummary(store);
  renderStatus(store);
  renderLayout(store, shell, workspace);
  announceChanges(store, shell);
  bindKeys(store);

  const narrow = matchMedia(narrowQuery);
  store.setNarrow(narrow.matches);
  narrow.addEventListener('change', () => store.setNarrow(narrow.matches));

  boot.hidden = true;
  app.hidden = false;
  return store;
}

function renderHeader(store: Store) {
  const find = required('#find', HTMLInputElement);
  const undo = required('#undo', HTMLButtonElement);
  const redo = required('#redo', HTMLButtonElement);
  find.addEventListener('input', () => store.setQuery(find.value));
  undo.addEventListener('click', () => void store.undo());
  redo.addEventListener('click', () => void store.redo());
  store.watch(s => [s.model.package, s.model.files], ([name]) => {
    const { model } = store.state;
    setText(required('#package', HTMLElement), name as string);
    setText(required('#files', HTMLElement), model.files.map(file => file.path).join(', '));
    document.title = `${model.package} | Infergo editor`;
  });
  store.watch(s => [s.history, s.writing], () => {
    const state = store.state;
    const entries = state.history.entries;
    undo.disabled = !canUndo(state);
    redo.disabled = !canRedo(state);
    undo.title = canUndo(state) ? `Undo: ${entries[state.history.cursor - 1]!.label}` : 'Nothing to undo';
    redo.title = canRedo(state) ? `Redo: ${entries[state.history.cursor]!.label}` : 'Nothing to redo';
  });
}

function renderSummary(store: Store) {
  const summary = required('#summary', HTMLElement);
  store.watch(s => [s.model, s.check, s.connection], () => {
    const state = store.state;
    const { model } = state;
    const { errors, warnings } = problemCounts(state);
    const parts: HTMLElement[] = [
      h('span', {}, `${model.rules.length} ${model.rules.length === 1 ? 'rule' : 'rules'} · ${model.inputs.fields.length} inputs · ${model.outputs.fields.length} requested outputs`),
      h('span', {},
        h('span', { class: errors ? 'text-error' : undefined }, `${errors} ${errors === 1 ? 'error' : 'errors'}`), ' · ',
        h('span', { class: warnings ? 'text-warning' : undefined }, `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`)),
    ];
    for (const file of model.files) {
      if (file.state !== 'syntax_error') continue;
      const where = file.problem ? `:${file.problem.line}` : '';
      parts.push(h('span', { class: 'text-error' }, `${file.path}${where} does not parse. ${file.problem?.message ?? ''}`.trim()));
    }
    const evaluator = state.check?.evaluator;
    if (evaluator) {
      parts.push(evaluator === 'kept'
        ? h('span', { class: 'text-warning' }, 'Evaluator kept from the last valid check')
        : h('span', { class: 'text-teal' }, evaluator === 'updated' ? 'Evaluator updated' : 'Evaluator current'));
    }
    if (checkPending(state)) parts.push(h('span', {}, 'Checking'));
    summary.replaceChildren(...parts);
  });
}

// The status line: the gesture in progress, else the newest notice with its
// Undo or Redo, and on the right the connection or the mock's name. The action
// button is one persistent element whose label flips between Undo and Redo, so
// pressing it never destroys the element that has focus.
function renderStatus(store: Store) {
  const status = required('#status', HTMLElement);
  const message = h('span', { class: 'status-message' });
  const action = h('button', { type: 'button', class: 'link', hidden: true });
  const side = h('span', { class: 'status-side' });
  let act: (() => Promise<unknown>) | undefined;
  action.addEventListener('click', () => void act?.());
  status.replaceChildren(message, action, side);
  store.watch(s => [s.held, s.notice, s.history, s.connection, s.backend, s.graph], () => {
    const state = store.state;
    const left: HTMLElement[] = [];
    const right: HTMLElement[] = [];
    const { held, notice } = state;
    act = undefined;
    if (held) {
      const targets = validTargets(state).length;
      if (held.over && held.verdict?.ok) {
        left.push(h('span', { class: 'text-teal' }, `Drop to add ${held.fact.name} ${held.fact.type} to ${held.over}`));
      } else if (held.over && held.verdict && !held.verdict.ok) {
        left.push(h('span', { class: 'text-refused' }, `No drop here. ${verdictMessage(held.verdict, held.fact.name, held.over, state.graph)}.`));
      } else {
        left.push(h('span', { class: 'text-teal' }, `Holding ${held.fact.name} ${held.fact.type}`));
      }
      left.push(h('span', {}, 'Esc cancels'));
      right.push(h('span', {}, `${targets} ${targets === 1 ? 'rule' : 'rules'} can take this fact`));
    } else if (notice?.kind === 'receipt') {
      const { receipt } = notice;
      const verb = notice.action === 'undo' ? 'Undid: ' : notice.action === 'redo' ? 'Redid: ' : '';
      left.push(h('span', {}, `${verb}${receipt.label}`));
      left.push(h('span', { class: 'mono' }, receipt.files.map(file => `${file.path} +${file.added} \u2212${file.removed}`).join(', ')));
      if (receipt.note) left.push(h('span', {}, receipt.note));
      const { entries, cursor } = state.history;
      if (notice.action !== 'undo' && entries[cursor - 1]?.id === receipt.id && canUndo(state)) {
        act = () => store.undo();
        setText(action, 'Undo');
      } else if (notice.action === 'undo' && entries[cursor]?.id === receipt.id) {
        act = () => store.redo();
        setText(action, 'Redo');
      }
    } else if (notice?.kind === 'refusal') {
      left.push(h('span', { class: 'text-refused' }, notice.refusal.message));
    } else if (notice?.kind === 'error') {
      left.push(h('span', { class: 'text-error' }, notice.message));
    }
    if (state.connection === 'lost') right.push(h('span', { class: 'text-error' }, 'Server unreachable. Retrying'));
    else if (state.connection === 'connecting') right.push(h('span', {}, 'Connecting'));
    if (state.backend === 'mock') right.push(h('span', {}, 'Mock server. Nothing is written to disk'));
    // A history event can land before the undo reply that will relabel the
    // button. Keep a focused button in place, inert, rather than hide it.
    const keep = !act && holdsFocus(action);
    action.hidden = !act && !keep;
    action.toggleAttribute('aria-disabled', keep);
    message.replaceChildren(...left);
    side.replaceChildren(...right);
  });
}

// Applies collapse state, the left tab, and which middle region is visible.
function renderLayout(store: Store, shell: Shell, workspace: HTMLElement) {
  const factsRoot = required('#facts-root', HTMLElement);
  const historyRoot = required('#history-root', HTMLElement);
  const graphRoot = required('#graph-root', HTMLElement);
  const listRoot = required('#list-root', HTMLElement);
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  const strips = [...document.querySelectorAll<HTMLButtonElement>('[data-toggle]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => store.setSideTab(tab.dataset.tab === 'history' ? 'history' : 'facts'));
    tab.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      store.setSideTab(store.state.sideTab === 'facts' ? 'history' : 'facts');
      document.querySelector<HTMLButtonElement>(`[data-tab="${store.state.sideTab}"]`)?.focus();
    });
  }
  for (const strip of strips) strip.addEventListener('click', () => store.toggleColumn(strip.dataset.toggle === 'rule' ? 'rule' : 'facts'));
  store.watch(s => [s.collapsed, s.narrow, s.sideTab, s.layout], () => {
    const { collapsed, narrow, sideTab, layout } = store.state;
    workspace.classList.toggle('facts-collapsed', collapsed.facts && !narrow);
    workspace.classList.toggle('rule-collapsed', collapsed.rule && !narrow);
    for (const strip of strips) strip.hidden = narrow || !collapsed[strip.dataset.toggle === 'rule' ? 'rule' : 'facts'];
    for (const tab of tabs) {
      const selected = tab.dataset.tab === sideTab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    factsRoot.hidden = sideTab !== 'facts';
    historyRoot.hidden = sideTab !== 'history';
    graphRoot.hidden = layout !== 'canvas';
    listRoot.hidden = layout !== 'list';
    if (!narrow) shell.placeRuleDetail(undefined);
  });
}

// Speaks receipts, refusals, a new hold, and changes in the error count.
function announceChanges(store: Store, shell: Shell) {
  store.watch(s => s.notice, notice => {
    if (!notice) return;
    if (notice.kind === 'receipt') shell.announce(`${notice.action === 'undo' ? 'Undid: ' : notice.action === 'redo' ? 'Redid: ' : ''}${notice.receipt.label}`);
    else shell.announce(notice.kind === 'refusal' ? notice.refusal.message : notice.message);
  }, { immediate: false });
  store.watch(s => s.held?.fact.name, name => {
    if (!name) return;
    const targets = validTargets(store.state).length;
    shell.announce(`Holding ${name}. ${targets} ${targets === 1 ? 'rule' : 'rules'} can take it. Esc cancels.`);
  }, { immediate: false });
  let spoken = '';
  store.watch(s => s.check && problemCounts(s), counts => {
    if (!counts) return;
    const text = `${counts.errors} ${counts.errors === 1 ? 'error' : 'errors'}, ${counts.warnings} ${counts.warnings === 1 ? 'warning' : 'warnings'}`;
    if (spoken && text !== spoken) shell.announce(text);
    spoken = text;
  }, { equals: (a, b) => a?.errors === b?.errors && a?.warnings === b?.warnings });
}

// Elements where a key belongs to the text under the caret, not to the page.
function editable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[data-region="code"]')) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'submit', 'reset'].includes(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}

// Global keys run in the bubbling phase and skip any event a region already
// handled with preventDefault, so a region's own Esc or arrow keys win.
function bindKeys(store: Store) {
  const keys = required('#keys', HTMLDialogElement);
  required('#keys-close', HTMLButtonElement).addEventListener('click', () => keys.close());
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing) return;
    const state: State = store.state;
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (command && !event.altKey && (key === 'z' || key === 'y')) {
      if (editable(event.target)) return; // the code pane and text fields undo their own text
      event.preventDefault();
      if (key === 'y' || event.shiftKey) void store.redo();
      else void store.undo();
      return;
    }
    if (event.key === 'Escape' && state.held) {
      event.preventDefault();
      store.cancel();
      return;
    }
    if (command || event.altKey || editable(event.target)) return;
    if (event.key === '?') {
      event.preventDefault();
      if (keys.open) keys.close();
      else keys.showModal();
    } else if ((event.key === '[' || event.key === ']') && !state.narrow) {
      event.preventDefault();
      store.toggleColumn(event.key === '[' ? 'facts' : 'rule');
    }
  });
}
