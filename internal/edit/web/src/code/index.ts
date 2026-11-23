// Code pane. Shows the selected rule's doc comment and declaration in a
// CodeMirror buffer the user types into, saves it with replace_source after a
// pause, and formats it on leaving. A preview (a held fact over a rule, a
// remove button under the pointer, a focused fix link) shows in a second,
// read-only view, so the buffer, its caret, and its undo history are never
// touched by it. The save machine is in sync.ts, the diff in diff.ts.
//
// Other regions open the pane by focusing #code-root: focus moves into the
// buffer, Esc goes back to where it came from, and a stub rule gets its caret
// on the body line.
import { setDiagnostics, type Diagnostic as LintDiagnostic } from '@codemirror/lint';
import { Annotation, Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { h, reconcile, setText } from '../dom';
import type { Rule } from '../protocol';
import type { Region } from '../region';
import { diagnosticsFor, previewChange, shownRule, type Store } from '../store';
import { diff, minimalEdits, previewMarks } from './diff';
import { baseExtensions, setFirstLine, setLineMarks, setLit, setPreviewMarks, type LineMark } from './editor';
import { firstFileLine, placeDiagnostic, stubCaret } from './lines';
import {
  edited, isDirty, keepMine, loadDisk, loaded, replied, send, settle, wantsSend, type Step, type Sync,
} from './sync';

/** Milliseconds without a keystroke before the buffer is sent. */
const idleDelay = 300;

/**
 * One buffer. The active one lives in the edit view; a buffer left with
 * unsaved text that could not be written is kept in `drafts` with its
 * EditorState, and comes back when its rule is selected again.
 */
type Buffer = { sync: Sync; state?: EditorState; pending?: Promise<void>; fresh: boolean };

/** Marks the pane's own changes to the buffer, which are not typing. */
const fromModel = Annotation.define<boolean>();

export const mount: Region = (root, store) => {
  const where = h('span', { class: 'code-where mono' });
  const status = h('span', { class: 'code-status' });
  const heading = h('h3', { class: 'section-heading code-heading', id: 'code-heading' }, 'Source', h('span', { class: 'push code-meta' }, where, status));
  const staleText = h('p', { class: 'code-stale-text' });
  const loadButton = h('button', { type: 'button' }, 'Load the version on disk');
  const keepButton = h('button', { type: 'button' }, 'Keep my text');
  const stale = h('div', { class: 'code-stale row-refused', hidden: true }, staleText, h('div', { class: 'code-choices' }, loadButton, keepButton));
  const readOnly = h('p', { class: 'code-read-only', hidden: true });
  const editHost = h('div', { class: 'code-view code-edit' });
  const previewHost = h('div', { class: 'code-view code-preview', hidden: true });
  const problems = h('ul', { class: 'code-problems', 'aria-label': 'Problems in this code' });
  root.append(heading, stale, readOnly, editHost, previewHost, problems);
  root.tabIndex = -1;

  let active: Buffer | undefined;
  const drafts = new Map<string, Buffer>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let historyStep: number | undefined; // model revision when an undo or redo was about to be sent
  let litByPane: string | undefined; // the fact this pane lit, so it clears only its own
  let returnTo: HTMLElement | undefined;
  let previewing = false;
  let savedScroll: { element: Element; top: number } | undefined;
  let focusBack = false; // the buffer had focus when a preview hid it
  let previewKey = ''; // what the preview view shows, to skip rebuilding it
  let diagnosticsKey = ''; // what the lint markers show, likewise

  const label = new Compartment();
  const editExtensions = [
    ...baseExtensions({ editable: true, onSave: () => { clearTimeout(timer); if (active) void save(active, 'save'); }, label: label.of([]) }),
    Prec.highest(keymap.of([{ key: 'Escape', run: () => leave() }])),
    // The reactions dispatch to the views again, which CodeMirror forbids
    // inside an update, so they run right after it.
    EditorView.updateListener.of(update => {
      if (update.docChanged && update.transactions.some(tr => !tr.annotation(fromModel))) queueMicrotask(typed);
      if (update.selectionSet || update.focusChanged) queueMicrotask(lightFromCaret);
    }),
  ];
  const previewExtensions = baseExtensions({ editable: false, label: EditorView.contentAttributes.of({ 'aria-label': 'Preview of the pending change' }) });
  const editView = new EditorView({ parent: editHost, state: EditorState.create({ extensions: editExtensions }) });
  const previewView = new EditorView({ parent: previewHost, state: EditorState.create({ extensions: previewExtensions }) });

  const text = (buffer: Buffer) => (buffer === active ? editView.state.doc.toString() : buffer.state!.doc.toString());
  const ruleOf = (buffer: Buffer | undefined) => (buffer ? store.state.graph.rules.get(buffer.sync.rule) : undefined);

  // ---- Saving ---------------------------------------------------------------

  // Sends the buffer when the machine wants to. Resolves once the reply is
  // handled; a write already in flight is waited for instead.
  function save(buffer: Buffer, reason: 'idle' | 'leave' | 'save'): Promise<void> {
    if (buffer.pending) return buffer.pending;
    const current = text(buffer);
    if (!wantsSend(buffer.sync, current, reason)) return Promise.resolve();
    const started = send(buffer.sync, current, reason !== 'idle');
    buffer.sync = started.sync;
    render();
    buffer.pending = store.apply(started.op).then(result => {
      buffer.pending = undefined;
      buffer.sync = replied(buffer.sync, result.kind === 'ok' ? { kind: 'ok', revision: result.value.revision } : result);
      reconcileBuffer(buffer);
      if (buffer === active && wantsSend(buffer.sync, text(buffer), 'idle')) schedule();
      render();
    });
    return buffer.pending;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (active) void save(active, 'idle'); }, idleDelay);
  }

  function typed() {
    if (!active) return;
    active.fresh = false;
    active.sync = edited(active.sync, editView.state.doc.toString());
    schedule();
    render();
  }

  // Applies a settle step to a buffer: the model moved, or a reply landed.
  function reconcileBuffer(buffer: Buffer) {
    const step: Step = settle(buffer.sync, ruleOf(buffer), text(buffer), store.state.model.revision);
    buffer.sync = step.sync;
    if (step.load !== undefined) put(buffer, step.load, false);
    if (buffer !== active && !buffer.pending && !buffer.sync.landed && !buffer.sync.problem && !isDirty(buffer.sync, text(buffer))) {
      drafts.delete(buffer.sync.rule);
    }
  }

  // Puts text into a buffer as the smallest change, so the caret stays on its
  // line. `undoable` makes it one undo step ("Load the version on disk").
  // After a history undo or redo the buffer's own history is cleared instead,
  // so the two stacks cannot disagree.
  function put(buffer: Buffer, next: string, undoable: boolean) {
    const changes = minimalEdits(text(buffer), next);
    if (!changes.length) return;
    if (buffer !== active) {
      buffer.state = buffer.state!.update({ changes, annotations: [fromModel.of(true), Transaction.addToHistory.of(false)] }).state;
      return;
    }
    if (!undoable && historyStep !== undefined) {
      const line = editView.state.doc.lineAt(editView.state.selection.main.head).number;
      const state = EditorState.create({ doc: next, extensions: editExtensions });
      const head = state.doc.line(Math.min(line, state.doc.lines)).from;
      replaceState(state.update({ selection: { anchor: head } }).state);
      return;
    }
    editView.dispatch({ changes, annotations: [fromModel.of(true), ...(undoable ? [] : [Transaction.addToHistory.of(false)])] });
  }

  // Swaps the edit view's state and restores what the fields hold.
  function replaceState(state: EditorState) {
    editView.setState(state);
    const rule = ruleOf(active);
    editView.dispatch({
      effects: [
        label.reconfigure(EditorView.contentAttributes.of({ 'aria-label': rule ? `Code of ${rule.id}` : 'Code', 'aria-describedby': 'code-heading' })),
        setFirstLine.of(rule ? firstFileLine(rule) : 1),
        setLit.of(store.state.highlight),
      ],
      annotations: fromModel.of(true),
    });
  }

  // ---- Which buffer is active -------------------------------------------------

  function load(id: string) {
    const draft = drafts.get(id);
    const rule = store.state.graph.rules.get(id)!;
    if (draft) {
      drafts.delete(id);
      active = draft;
      const state = draft.state!;
      draft.state = undefined;
      replaceState(state);
      reconcileBuffer(draft);
    } else {
      active = { sync: loaded(rule), fresh: true };
      replaceState(EditorState.create({ doc: rule.source, extensions: editExtensions }));
    }
  }

  // Leaving a buffer for another rule saves it formatted. Until that write
  // lands, or if it cannot, the buffer is kept as a draft.
  function stash(buffer: Buffer) {
    clearTimeout(timer);
    buffer.state = editView.state;
    active = undefined;
    const current = buffer.state.doc.toString();
    if (buffer.pending || buffer.sync.problem || isDirty(buffer.sync, current)) {
      drafts.set(buffer.sync.rule, buffer);
      void save(buffer, 'leave');
    } else if (wantsSend(buffer.sync, current, 'leave')) void save(buffer, 'leave');
  }

  store.watch(s => [s.model, s.selection.rule], () => {
    const state = store.state;
    const id = state.selection.rule;
    const sent = active?.sync.sent;
    // A rename in the buffer: keep the selection on the renamed declaration.
    if (active && sent?.renameTo && id !== sent.renameTo && state.graph.rules.has(sent.renameTo) && !state.graph.rules.has(active.sync.rule)) {
      store.select({ rule: sent.renameTo });
      return;
    }
    for (const draft of [...drafts.values()]) reconcileBuffer(draft);
    if (!id || !state.graph.rules.has(id)) {
      if (active) stash(active);
    } else if (active && active.sync.rule !== id && sent?.renameTo !== id) {
      stash(active);
      load(id);
    } else if (!active) load(id);
    else {
      reconcileBuffer(active);
      const rule = ruleOf(active);
      if (rule) editView.dispatch({ effects: setFirstLine.of(firstFileLine(rule)), annotations: fromModel.of(true) });
    }
    if (historyStep !== undefined && state.model.revision > historyStep) historyStep = undefined;
    render();
  });

  // ---- Writes elsewhere ---------------------------------------------------------

  // Before another region's gesture is sent, unsaved text goes first, formatted.
  // Before an undo or redo, note it, so the reload that follows clears the buffer's history.
  store.beforeWrite(async write => {
    if (write.op?.op === 'replace_source') return;
    if (write.action !== 'apply') { historyStep = store.state.model.revision; return; }
    clearTimeout(timer);
    while (active?.pending) await active.pending;
    if (active) await save(active, 'leave');
  });

  // Picking a fact up saves too, so the preview is computed from the buffer's text.
  store.watch(s => !!s.held, held => {
    if (held && active && isDirty(active.sync, editView.state.doc.toString())) { clearTimeout(timer); void save(active, 'leave'); }
  }, { immediate: false });

  // ---- Focus -------------------------------------------------------------------

  root.addEventListener('focusin', event => {
    const from = event.relatedTarget;
    if (from instanceof HTMLElement && !root.contains(from)) returnTo = from;
    if (event.target === root && !editHost.hidden) editView.focus();
    if (editView.hasFocus && active?.fresh) {
      active.fresh = false;
      const rule = ruleOf(active);
      if (rule?.stub) editView.dispatch({ selection: { anchor: stubCaret(editView.state.doc.toString()) }, scrollIntoView: true });
    }
  });

  root.addEventListener('focusout', event => {
    const to = event.relatedTarget;
    if (to instanceof Node && root.contains(to)) return;
    clearLit();
    if (active) { clearTimeout(timer); void save(active, 'leave'); }
  });

  // Esc gives focus back to where it came from. With a fact held, the shell's Esc puts it down.
  function leave(): boolean {
    if (store.state.held) return false;
    if (returnTo?.isConnected && !root.contains(returnTo)) returnTo.focus();
    else editView.contentDOM.blur();
    return true;
  }

  // ---- One fact, lit everywhere ---------------------------------------------------

  // Lights the fact under the caret or pointer when it is one the rule reads or produces.
  function lightAt(view: EditorView, pos: number | null, rule: Rule | undefined) {
    const range = pos === null ? null : view.state.wordAt(pos);
    const word = range ? view.state.sliceDoc(range.from, range.to) : undefined;
    const fact = word && rule && [...rule.reads, ...rule.produces].some(item => item.name === word) ? word : undefined;
    if (fact) {
      litByPane = fact;
      store.highlight(fact);
    } else clearLit();
  }

  function clearLit() {
    if (litByPane !== undefined && store.state.highlight === litByPane) store.highlight(undefined);
    litByPane = undefined;
  }

  function lightFromCaret() {
    if (!editView.hasFocus) return;
    lightAt(editView, editView.state.selection.main.head, ruleOf(active));
  }

  for (const [view, rule] of [[editView, () => ruleOf(active)], [previewView, () => shownRule(store.state)]] as const) {
    view.contentDOM.addEventListener('pointermove', event => {
      if (event.pointerType === 'touch') return;
      lightAt(view, view.posAtCoords({ x: event.clientX, y: event.clientY }), rule());
    });
    view.contentDOM.addEventListener('pointerleave', () => {
      if (view === editView && editView.hasFocus) lightFromCaret();
      else clearLit();
    });
  }

  store.watch(s => s.highlight, fact => {
    for (const view of [editView, previewView]) view.dispatch({ effects: setLit.of(fact), annotations: fromModel.of(true) });
  });

  // ---- Stale choices -------------------------------------------------------------

  loadButton.addEventListener('click', () => {
    if (!active) return;
    const step = loadDisk(active.sync);
    active.sync = step.sync;
    if (step.load !== undefined) put(active, step.load, true);
    render();
    editView.focus();
  });
  keepButton.addEventListener('click', () => {
    if (!active) return;
    active.sync = keepMine(active.sync);
    void save(active, 'idle');
    render();
    editView.focus();
  });

  // ---- Rendering ------------------------------------------------------------------

  store.watch(s => [shownRule(s), s.preview, s.check, s.model], () => render());

  function render() {
    const state = store.state;
    const shown = shownRule(state);
    const change = shown ? previewChange(state, shown.id) : undefined;
    const buffered = active && ruleOf(active);
    const preview = !!shown && (!!change || shown.id !== active?.sync.rule);
    root.hidden = !shown && !buffered;
    if (root.hidden) return;

    setPreviewing(preview);
    if (preview && shown) {
      renderPreview(shown, change);
      setText(where, `${shown.file}:${firstFileLine(shown)}`);
      setText(status, change ? 'Preview, not written' : '');
      status.className = `code-status${change ? ' text-teal' : ''}`;
      stale.hidden = true;
      readOnly.hidden = true;
      problems.hidden = true;
      return;
    }
    if (!active || !buffered) return;
    const rule = buffered;
    const unknown = rule.source === '';
    readOnly.hidden = !unknown;
    editHost.hidden = unknown;
    if (unknown) {
      const file = state.model.files.find(item => item.path === rule.file);
      setText(readOnly, `${rule.file} does not parse${file?.problem ? ` at line ${file.problem.line}` : ''}, so the code of ${rule.id} is unknown. Fix the file in your editor.`);
    }
    setText(where, `${rule.file}:${firstFileLine(rule)}`);
    const [word, tone] = describe(active.sync, editView.state.doc.toString(), firstFileLine(rule));
    setText(status, word);
    status.className = `code-status${tone ? ` ${tone}` : ''}`;
    const problem = active.sync.problem;
    stale.hidden = problem?.kind !== 'stale';
    if (problem?.kind === 'stale') setText(staleText, `${rule.id} changed on disk while this pane has unsaved text.`);
    renderProblems(rule);
  }

  // Hides one view and shows the other, keeping the buffer's scroll position.
  function setPreviewing(on: boolean) {
    if (on === previewing) return;
    previewing = on;
    if (on) {
      const element = scrollParent(root);
      savedScroll = { element, top: element.scrollTop };
      focusBack = editView.hasFocus;
      editHost.hidden = true;
      previewHost.hidden = false;
    } else {
      previewHost.hidden = true;
      editHost.hidden = false;
      editView.requestMeasure();
      if (savedScroll) savedScroll.element.scrollTop = savedScroll.top;
      savedScroll = undefined;
      // Hiding the buffer dropped its focus; give it back unless focus went somewhere else.
      const now = document.activeElement;
      if (focusBack && (!now || now === document.body)) editView.focus();
      focusBack = false;
    }
  }

  function renderPreview(rule: Rule, change: ReturnType<typeof previewChange>) {
    const doc = change ? change.after : rule.source;
    const key = `${rule.id}\n${rule.line}\n${change ? change.before : ''}\n${doc}`;
    if (key === previewKey) return;
    previewKey = key;
    const marks = change ? previewMarks(diff(change.before, change.after)) : undefined;
    previewView.setState(EditorState.create({ doc, extensions: previewExtensions }));
    const lines = new Map<number, LineMark>();
    if (marks) {
      const lineOf = (at: number) => previewView.state.doc.lineAt(at).number;
      for (const removed of marks.removed) lines.set(lineOf(removed.at), 'remove');
      for (const range of marks.inserted) {
        for (let line = lineOf(range.from); line <= lineOf(Math.max(range.from, range.to - 1)); line++) lines.set(line, 'insert');
      }
    }
    previewView.dispatch({
      effects: [setFirstLine.of(firstFileLine(rule)), setPreviewMarks.of(marks), setLineMarks.of({ source: 'preview', marks: lines }), setLit.of(store.state.highlight)],
    });
  }

  // Lint markers and the problem list under the buffer: the save problem, then
  // the compiler's diagnostics whose line falls inside the declaration.
  function renderProblems(rule: Rule) {
    const state = store.state;
    const doc = editView.state.doc.toString();
    const first = firstFileLine(rule);
    const placed = diagnosticsFor(state, { rule: rule.id })
      .filter(diagnostic => diagnostic.file === rule.file)
      .map(diagnostic => placeDiagnostic(doc, first, diagnostic))
      .filter(item => item !== undefined);
    const problem = active?.sync.problem;
    const items: { key: string; tone: string; text: string }[] = [];
    if (problem?.kind === 'syntax') {
      items.push({ key: 'save', tone: 'row-error', text: problem.line ? `Line ${first + problem.line - 1} does not parse. ${problem.message}` : problem.message });
    } else if (problem?.kind === 'refused') items.push({ key: 'save', tone: 'row-refused', text: `Not saved. ${problem.message}` });
    else if (problem?.kind === 'failed') items.push({ key: 'save', tone: 'row-error', text: `Not saved. ${problem.message}` });
    for (const item of placed) {
      const { severity, message } = item.diagnostic;
      items.push({
        key: `${item.line}:${message}`, tone: severity === 'error' ? 'row-error' : 'row-warning',
        text: `${severity === 'error' ? 'Error' : 'Warning'} on line ${first + item.line - 1}: ${message}`,
      });
    }
    problems.hidden = !items.length;
    reconcile(problems, items, item => item.key, () => h('li'), (li, item) => { li.className = item.tone; setText(li, item.text); });

    const key = JSON.stringify([placed.map(item => [item.from, item.to, item.diagnostic.message]), problem?.kind === 'syntax' ? problem.line : 0, doc.length]);
    if (key === diagnosticsKey) return;
    diagnosticsKey = key;
    const lint: LintDiagnostic[] = placed.map(item => ({ from: item.from, to: item.to, severity: item.diagnostic.severity, message: item.diagnostic.message }));
    const marks = new Map<number, LineMark>();
    for (const item of placed) if (marks.get(item.line) !== 'error') marks.set(item.line, item.diagnostic.severity);
    if (problem?.kind === 'syntax' && problem.line && problem.text === doc) marks.set(problem.line, 'syntax');
    editView.dispatch({ ...setDiagnostics(editView.state, lint), annotations: fromModel.of(true) });
    editView.dispatch({ effects: setLineMarks.of({ source: 'problems', marks }), annotations: fromModel.of(true) });
  }
};

/** The heading's word for a buffer, and the class that colours it. */
function describe(sync: Sync, text: string, first: number): [string, string] {
  const problem = sync.problem;
  if (sync.sent) return ['Saving', ''];
  if (problem?.kind === 'syntax') return [problem.line ? `Syntax error at line ${first + problem.line - 1}` : 'Syntax error', 'text-error'];
  if (problem?.kind === 'stale') return ['Changed on disk', 'text-refused'];
  if (problem?.kind === 'refused') return ['Not saved', 'text-refused'];
  if (problem?.kind === 'failed') return ['Not saved', 'text-error'];
  if (sync.landed) return ['Saving', ''];
  return isDirty(sync, text) ? ['Unsaved', ''] : ['Saved', ''];
}

// The nearest ancestor that scrolls vertically, else the page.
function scrollParent(element: Element): Element {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement ?? document.documentElement;
}
