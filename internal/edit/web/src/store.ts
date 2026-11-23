// The page's single source of truth. Regions turn input into the actions below
// and turn State into pixels; they never call each other or the Api. The store
// owns the pick up, aim, drop machine for all three input routes (pointer,
// click, keyboard) and every server call. README.md has a worked example.
import type { Api, Connection, Result } from './api';
import {
  addReadOp, deriveGraph, opRule, sameOp, verdict, verdictMessage, verdicts, wireKey,
  type Graph, type Verdict, type Wire,
} from './derive';
import type {
  ApplyReply, Change, Check, Diagnostic, Fact, History, Model, Op, Receipt, Refusal, Rule, Values,
} from './protocol';

export type { Graph, Verdict, Wire } from './derive';

/**
 * The diff shown before anything is written. `loading` until the server
 * answers; `ready` with one Change per touched declaration; `refused` when the
 * server declined the op (for example a file that does not parse); `failed`
 * when the request itself failed.
 */
export type Preview =
  | { op: Op; state: 'loading' }
  | { op: Op; state: 'ready'; changes: Change[] }
  | { op: Op; state: 'refused'; refusal: Refusal }
  | { op: Op; state: 'failed'; error: string };

/**
 * A fact that has been picked up. `verdicts` holds the answer for every rule,
 * computed once on hold, so regions can outline valid targets and dim the rest
 * without asking. `over` is the rule being aimed at and `verdict` its entry.
 */
export type Held = {
  fact: Fact;
  verdicts: ReadonlyMap<string, Verdict>;
  over?: string;
  verdict?: Verdict;
};

/** What the status line reports: the newest receipt, a refusal, or a failed request. */
export type Notice =
  | { kind: 'receipt'; action: 'apply' | 'undo' | 'redo'; receipt: Receipt }
  | { kind: 'refusal'; refusal: Refusal }
  | { kind: 'error'; message: string };

/** What the user selected. Each part is independent; a region sets the parts it owns. */
export type Selection = { rule?: string; fact?: string; wire?: Wire };

export type State = {
  /** The newest model from the server, replaced whole on every model event. */
  model: Model;
  /** Derived from `model` by deriveGraph; replaced together with it. */
  graph: Graph;
  /** The newest compiler verdict. Its revision may trail `model.revision`; see checkPending. */
  check?: Check;
  /** Scenario snapshots, present only while values are enabled (stretch goal). */
  values?: Values;
  /** Whether scenario runs are on for the session. Off at start. */
  valuesEnabled: boolean;
  /** Case id picked in the header's Scenario select. */
  scenario?: string;
  /** The undo journal from the server. */
  history: History;
  selection: Selection;
  /** The fact lit everywhere: hovered or focused anywhere, cleared on leave. */
  highlight?: string;
  /** The fact being carried, while a pick up, aim, drop gesture is in progress. */
  held?: Held;
  /** The pending diff, for an aimed drop or an arbitrary op (remove button hover, fix link focus). */
  preview?: Preview;
  /** The newest receipt or refusal, for the status line and the live region. */
  notice?: Notice;
  /** Event stream state. */
  connection: Connection;
  /** Which Api backs the page. The status line names the mock. */
  backend: Api['kind'];
  /** Number of apply, undo, and redo requests in flight. */
  writing: number;
  /** The header's Find text, trimmed and lower-cased. Regions filter with matchesQuery. */
  query: string;
  /** The middle column's content: the canvas or the list view. Always `list` when `narrow`. */
  layout: 'canvas' | 'list';
  /** True below 1100 px: one column, the list view, and the rule detail under the selected rule. */
  narrow: boolean;
  /** The user's choice from the List toggle above 1100 px, kept while narrow. */
  listChosen: boolean;
  /** Side columns hidden with `[` and `]`. Ignored while narrow. */
  collapsed: { facts: boolean; rule: boolean };
  /** Which list the left column shows. */
  sideTab: 'facts' | 'history';
};

type Watcher = { run(state: State): void };

/** A write about to go to the server, as `beforeWrite` hooks see it. */
export type PendingWrite = { action: 'apply' | 'undo' | 'redo'; op?: Op };

export type WatchOptions<T> = {
  /** Defaults to Object.is, or element-wise Object.is when both values are arrays. */
  equals?: (a: T, b: T) => boolean;
  /** Call the listener once right away. Default true, so a mount renders immediately. */
  immediate?: boolean;
};

/** Object.is, extended element-wise to arrays, so a selector can return a tuple of slices. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

export class Store {
  #api: Api;
  #state: State;
  #watchers = new Set<Watcher>();
  #notifying = false;
  #dirty = false;
  #previewSeq = 0;
  #unsubscribe?: () => void;
  #beforeWrite = new Set<(write: PendingWrite) => void | Promise<void>>();

  private constructor(api: Api, model: Model) {
    this.#api = api;
    const graph = deriveGraph(model);
    this.#state = {
      model, graph, valuesEnabled: false, history: { entries: [], cursor: 0 },
      selection: { rule: defaultRule(model) }, connection: 'connecting', backend: api.kind, writing: 0,
      query: '', layout: 'canvas', narrow: false, listChosen: false, collapsed: { facts: false, rule: false }, sideTab: 'facts',
    };
  }

  /** Loads the model, then opens the event stream. Fails as a value when the model cannot be loaded. */
  static async connect(api: Api): Promise<Result<Store>> {
    const first = await api.model();
    if (first.kind !== 'ok') return first;
    const store = new Store(api, first.value);
    store.#listen();
    return { kind: 'ok', value: store };
  }

  get state(): State {
    return this.#state;
  }

  /**
   * Calls `listener` whenever `selector(state)` changes. Return a tuple of the
   * slices a region reads, and it rerenders only when one of them changes:
   * `store.watch(s => [s.model, s.selection.rule], ([model, rule]) => ...)`.
   * State is replaced immutably, so reference comparison is exact. Returns the
   * unsubscribe function.
   */
  watch<T>(selector: (state: State) => T, listener: (value: T, state: State) => void, options: WatchOptions<T> = {}): () => void {
    const equals = options.equals ?? shallowEqual;
    let previous = selector(this.#state);
    const watcher: Watcher = {
      run(state) {
        const next = selector(state);
        if (equals(previous, next)) return;
        previous = next;
        try {
          listener(next, state);
        } catch (error) {
          console.error('A store listener failed', error);
        }
      },
    };
    this.#watchers.add(watcher);
    if (options.immediate ?? true) listener(previous, this.#state);
    return () => { this.#watchers.delete(watcher); };
  }

  /**
   * Runs `hook` before every apply, undo, and redo is sent, and holds the
   * write until the promise it returns settles. The code pane uses it to save
   * unsaved text before another region's gesture lands. Returns the
   * unregister function.
   */
  beforeWrite(hook: (write: PendingWrite) => void | Promise<void>): () => void {
    this.#beforeWrite.add(hook);
    return () => { this.#beforeWrite.delete(hook); };
  }

  /** Stops the event stream and drops every watcher. */
  dispose() {
    this.#unsubscribe?.();
    this.#watchers.clear();
  }

  // ---- Selection and highlight ------------------------------------------

  /** Merges into the selection. Pass `{ rule: undefined }` to clear a part. */
  select(selection: Selection) {
    this.#set({ selection: { ...this.#state.selection, ...selection } });
  }

  /** Lights one fact everywhere, or clears the light. */
  highlight(fact?: string) {
    if (this.#state.highlight !== fact) this.#set({ highlight: fact });
  }

  // ---- Pick up, aim, drop -------------------------------------------------

  /** Picks a fact up and computes a verdict for every rule. Replaces a fact already held. */
  hold(fact: string) {
    const info = this.#state.graph.facts.get(fact);
    if (!info) return;
    this.#previewSeq++;
    this.#set({ held: { fact: { name: info.name, type: info.type }, verdicts: verdicts(this.#state.graph, fact) }, preview: undefined });
  }

  /** Aims the held fact at a rule, or at nothing. A valid target gets a preview; an invalid one only its verdict. */
  aim(rule?: string) {
    const held = this.#state.held;
    if (!held || held.over === rule) return;
    if (!rule) {
      this.#previewSeq++;
      this.#set({ held: { fact: held.fact, verdicts: held.verdicts }, preview: undefined });
      return;
    }
    const result = held.verdicts.get(rule) ?? verdict(this.#state.graph, held.fact.name, rule);
    this.#set({ held: { ...held, over: rule, verdict: result } });
    if (result.ok) void this.#requestPreview(addReadOp(this.#state.graph, held.fact.name, rule));
    else { this.#previewSeq++; this.#set({ preview: undefined }); }
  }

  /**
   * Applies exactly the previewed op. With no target it cancels. On an invalid
   * target, or a preview the server refused, it reports why and writes nothing.
   * The target becomes the selected rule, so the sheet keeps showing it.
   */
  async drop(): Promise<void> {
    const { held, preview, graph } = this.#state;
    if (!held) return;
    if (!held.over) { this.cancel(); return; }
    const target = held.over;
    const result = held.verdict ?? verdict(graph, held.fact.name, target);
    if (!result.ok) {
      const message = `No drop here. ${verdictMessage(result, held.fact.name, target, graph)}.`;
      const reason: Refusal['reason'] = result.reason === 'cycle' ? 'cycle' : result.reason === 'unsupported' ? 'unsupported' : 'exists';
      this.cancel();
      this.#set({ notice: { kind: 'refusal', refusal: { reason, message, ...(result.reason === 'cycle' ? { related: result.path } : {}) } } });
      return;
    }
    const expected = addReadOp(graph, held.fact.name, target);
    if (preview && sameOp(preview.op, expected) && preview.state === 'refused') {
      this.cancel();
      this.#set({ notice: { kind: 'refusal', refusal: preview.refusal } });
      return;
    }
    const op = preview && sameOp(preview.op, expected) ? preview.op : expected;
    this.#previewSeq++;
    this.#set({ held: undefined, preview: undefined, selection: { ...this.#state.selection, rule: target } });
    await this.apply(op);
  }

  /** Puts the held fact down and clears its preview. Nothing is written. */
  cancel() {
    if (!this.#state.held) return;
    this.#previewSeq++;
    this.#set({ held: undefined, preview: undefined });
  }

  // ---- Previews of arbitrary ops ------------------------------------------

  /** Shows what an op would change, for a remove button under the pointer or a focused fix link. */
  previewOp(op: Op) {
    void this.#requestPreview(op);
  }

  /** Clears the preview. With an op, clears it only if it is still that op's, so a late leave cannot clear a newer preview. */
  clearPreview(op?: Op) {
    const preview = this.#state.preview;
    if (!preview || (op && !sameOp(op, preview.op))) return;
    this.#previewSeq++;
    this.#set({ preview: undefined });
  }

  // ---- Writes -------------------------------------------------------------

  /** Applies an op. The new model arrives on the event stream; the receipt or refusal lands in `notice`. */
  apply(op: Op): Promise<Result<ApplyReply>> {
    return this.#write('apply', () => this.#api.apply(op), op);
  }

  undo(): Promise<Result<ApplyReply>> {
    return this.#write('undo', () => this.#api.undo());
  }

  redo(): Promise<Result<ApplyReply>> {
    return this.#write('redo', () => this.#api.redo());
  }

  /** Turns scenario runs on or off. Values clear when turned off. */
  async setValues(enabled: boolean): Promise<Result<void>> {
    const result = await this.#api.setValues(enabled);
    if (result.kind === 'ok') this.#set({ valuesEnabled: enabled, ...(enabled ? {} : { values: undefined }) });
    else this.#set({ notice: noticeFor(result) });
    return result;
  }

  /** Clears the status line's notice. */
  dismissNotice() {
    if (this.#state.notice) this.#set({ notice: undefined });
  }

  // ---- Shell state ---------------------------------------------------------

  setQuery(text: string) {
    const query = text.trim().toLocaleLowerCase();
    if (query !== this.#state.query) this.#set({ query });
  }

  /** Called by the shell when the viewport crosses 1100 px. */
  setNarrow(narrow: boolean) {
    if (narrow === this.#state.narrow) return;
    this.#set({ narrow, layout: narrow || this.#state.listChosen ? 'list' : 'canvas' });
  }

  /** The List toggle above 1100 px. */
  setListView(list: boolean) {
    this.#set({ listChosen: list, layout: list || this.#state.narrow ? 'list' : 'canvas' });
  }

  toggleColumn(column: 'facts' | 'rule') {
    const collapsed = this.#state.collapsed;
    this.#set({ collapsed: { ...collapsed, [column]: !collapsed[column] } });
  }

  setSideTab(sideTab: State['sideTab']) {
    if (sideTab !== this.#state.sideTab) this.#set({ sideTab });
  }

  setScenario(scenario?: string) {
    this.#set({ scenario });
  }

  // ---- Internals -----------------------------------------------------------

  #set(patch: Partial<State>) {
    this.#state = { ...this.#state, ...patch };
    this.#notify();
  }

  // Listeners may dispatch actions; those changes are delivered after the
  // current pass, so every watcher sees states in order and none is skipped.
  #notify() {
    if (this.#notifying) { this.#dirty = true; return; }
    this.#notifying = true;
    try {
      do {
        this.#dirty = false;
        for (const watcher of [...this.#watchers]) watcher.run(this.#state);
      } while (this.#dirty);
    } finally {
      this.#notifying = false;
    }
  }

  async #requestPreview(op: Op) {
    const seq = ++this.#previewSeq;
    // Re-requesting the shown op keeps the old diff on screen until the reply.
    if (!this.#state.preview || !sameOp(this.#state.preview.op, op)) this.#set({ preview: { op, state: 'loading' } });
    const result = await this.#api.preview(op);
    if (seq !== this.#previewSeq) return; // a newer aim, cancel, or clear superseded this reply
    switch (result.kind) {
      case 'ok': this.#set({ preview: { op, state: 'ready', changes: result.value.changes } }); break;
      case 'refused': this.#set({ preview: { op, state: 'refused', refusal: result.refusal } }); break;
      case 'failed': this.#set({ preview: { op, state: 'failed', error: result.error } }); break;
    }
  }

  async #write(action: 'apply' | 'undo' | 'redo', send: () => Promise<Result<ApplyReply>>, op?: Op): Promise<Result<ApplyReply>> {
    this.#set({ writing: this.#state.writing + 1 });
    await Promise.all([...this.#beforeWrite].map(async hook => {
      try {
        await hook({ action, ...(op ? { op } : {}) });
      } catch (error) {
        console.error('A beforeWrite hook failed', error);
      }
    }));
    const result = await send();
    this.#set({
      writing: this.#state.writing - 1,
      notice: result.kind === 'ok' ? { kind: 'receipt', action, receipt: result.value.receipt } : noticeFor(result),
    });
    return result;
  }

  #listen() {
    let lost = false;
    this.#unsubscribe = this.#api.subscribe({
      model: model => this.#onModel(model),
      history: history => this.#set({ history }),
      check: check => {
        const current = this.#state.check;
        if (!current || check.revision >= current.revision) this.#set({ check });
      },
      values: values => { if (this.#state.valuesEnabled) this.#set({ values }); },
      connection: connection => {
        // After a gap the stream may have missed events, so reload the model.
        if (connection === 'open' && lost) void this.#api.model().then(result => {
          if (result.kind === 'ok') this.#onModel(result.value);
          else this.#set({ notice: noticeFor(result) });
        });
        lost = connection === 'lost' || (lost && connection !== 'open');
        if (connection !== this.#state.connection) this.#set({ connection });
      },
    });
  }

  // A new model replaces the graph, then every piece of state that names a rule
  // or fact is checked against it, so no region ever sees a dangling name.
  #onModel(model: Model) {
    const graph = deriveGraph(model);
    const { selection, highlight, held, preview } = this.#state;
    const wire = selection.wire && graph.wires.find(candidate => wireKey(candidate) === wireKey(selection.wire!));
    const next: Partial<State> = {
      model, graph,
      selection: {
        rule: selection.rule && graph.rules.has(selection.rule) ? selection.rule : renamedRule(this.#state.model, model, selection.rule) ?? defaultRule(model),
        ...(selection.fact && graph.facts.has(selection.fact) ? { fact: selection.fact } : {}),
        ...(wire ? { wire } : {}),
      },
      highlight: highlight && graph.facts.has(highlight) ? highlight : undefined,
    };
    let previewOp = preview?.op;
    if (held) {
      const info = graph.facts.get(held.fact.name);
      if (!info) {
        next.held = undefined;
        previewOp = undefined;
      } else {
        const all = verdicts(graph, info.name);
        const over = held.over && graph.rules.has(held.over) ? held.over : undefined;
        const result = over ? all.get(over) : undefined;
        next.held = { fact: { name: info.name, type: info.type }, verdicts: all, ...(over ? { over, verdict: result } : {}) };
        previewOp = over && result?.ok ? addReadOp(graph, info.name, over) : undefined;
      }
    }
    if (!previewOp) { this.#previewSeq++; next.preview = undefined; }
    this.#set(next);
    if (previewOp) void this.#requestPreview(previewOp);
  }
}

function noticeFor(result: Exclude<Result<unknown>, { kind: 'ok' }>): Notice {
  return result.kind === 'refused' ? { kind: 'refusal', refusal: result.refusal } : { kind: 'error', message: result.error };
}

/** The rule selected at start and after the selected rule disappears: the first output's producer, as the viewer does. */
function defaultRule(model: Model): string | undefined {
  const first = model.outputs.fields[0]?.fact;
  return model.rules.find(rule => rule.produces.some(fact => fact.name === first))?.id ?? model.rules[0]?.id;
}

/**
 * The new id of a rule that a model change renamed: a rule the old model did
 * not have, in the same file, whose func line is where the old rule's was. Lets
 * the selection follow a rename made in the code pane, the sheet, or an IDE.
 */
function renamedRule(previous: Model, model: Model, id: string | undefined): string | undefined {
  const old = id ? previous.rules.find(rule => rule.id === id) : undefined;
  if (!old) return undefined;
  const known = new Set(previous.rules.map(rule => rule.id));
  return model.rules.find(rule => !known.has(rule.id) && rule.file === old.file && rule.line === old.line)?.id;
}

// ---- Selectors. Pure functions of State that several regions need. ---------

/**
 * The rule the sheet and the code pane show: the rule a preview edits, else
 * the rule being aimed at, else the selection. This is how the pane shows the
 * target's declaration while a fact is held over it.
 */
export function shownRule(state: State): Rule | undefined {
  const fromPreview = state.preview && opRule(state.preview.op);
  const id = (fromPreview && state.graph.rules.has(fromPreview) ? fromPreview : undefined) ?? state.held?.over ?? state.selection.rule;
  return id ? state.graph.rules.get(id) : undefined;
}

/** The ready preview's Change for one rule, if the pending op touches it. */
export function previewChange(state: State, rule: string): Change | undefined {
  return state.preview?.state === 'ready' ? state.preview.changes.find(change => change.rule === rule) : undefined;
}

/** The read a pending add_read would give `rule`, for drawing the teal plus row. */
export function pendingRead(state: State, rule: string): Fact | undefined {
  const op = state.preview?.op;
  return op?.op === 'add_read' && op.rule === rule ? { name: op.fact, type: op.type } : undefined;
}

/** True while the compiler has not reported on the current revision. The summary shows "Checking". */
export function checkPending(state: State): boolean {
  return !state.check || state.check.revision < state.model.revision;
}

export function problemCounts(state: State): { errors: number; warnings: number } {
  const diagnostics = state.check?.diagnostics ?? [];
  return {
    errors: diagnostics.filter(diagnostic => diagnostic.severity === 'error').length,
    warnings: diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length,
  };
}

/** Diagnostics about a rule, a fact, or both (both must match when both are given). */
export function diagnosticsFor(state: State, about: { rule?: string; fact?: string }): Diagnostic[] {
  return (state.check?.diagnostics ?? []).filter(diagnostic =>
    (about.rule === undefined || diagnostic.rule === about.rule || diagnostic.related?.includes(about.rule))
    && (about.fact === undefined || diagnostic.fact === about.fact));
}

export function canUndo(state: State): boolean {
  const entry = state.history.entries[state.history.cursor - 1];
  return !!entry && entry.undoable !== false;
}

export function canRedo(state: State): boolean {
  return state.history.cursor < state.history.entries.length;
}

/** Whether a name or any of the given texts contains the Find query. Empty query matches everything. */
export function matchesQuery(state: State, ...texts: string[]): boolean {
  return !state.query || texts.some(text => text.toLocaleLowerCase().includes(state.query));
}

/** Rules that can take the held fact, in source order. Keyboard aim steps through these. */
export function validTargets(state: State): string[] {
  return state.held ? [...state.held.verdicts].filter(([, result]) => result.ok).map(([id]) => id) : [];
}
