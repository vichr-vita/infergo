// The CodeMirror setup the code pane shares between its two views: the
// editable buffer and the read-only preview. Highlighting uses weight and grey
// only, so the teal of a pending insertion or a lit fact, the amber of a
// removal, and the red of an error are never mistaken for syntax colour.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { go } from '@codemirror/lang-go';
import { HighlightStyle, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { forEachDiagnostic, lintKeymap } from '@codemirror/lint';
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, keymap, lineNumbers, showTooltip,
  type DecorationSet, type Tooltip, type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { PreviewMarks } from './diff';

// ---- File line numbers ------------------------------------------------------

/** Sets the file line of the buffer's first line, so the gutter shows real file line numbers. */
export const setFirstLine = StateEffect.define<number>();

const firstLine = StateField.define<number>({
  create: () => 1,
  update: (value, transaction) => transaction.effects.reduce((line, effect) => (effect.is(setFirstLine) ? effect.value : line), value),
});

// ---- Line marks: the narrow column left of the line numbers -----------------

/** What the mark column shows on a line: `+` inserted, `−` removed, `!` an error or warning. A `syntax` line is also underlined whole. */
export type LineMark = 'insert' | 'remove' | 'error' | 'warning' | 'syntax';

/** Replaces the line marks of one source (`preview` or `problems`). Keys are 1-based buffer lines. */
export const setLineMarks = StateEffect.define<{ source: 'preview' | 'problems'; marks: ReadonlyMap<number, LineMark> }>();

type Marks = { preview: ReadonlyMap<number, LineMark>; problems: ReadonlyMap<number, LineMark> };

const lineMarks = StateField.define<Marks>({
  create: () => ({ preview: new Map(), problems: new Map() }),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) if (effect.is(setLineMarks)) next = { ...next, [effect.value.source]: effect.value.marks };
    if (transaction.docChanged && next.problems.size) {
      // Keep a problem mark on its text while the user types above it.
      const moved = new Map<number, LineMark>();
      for (const [line, mark] of next.problems) {
        if (line > transaction.startState.doc.lines) continue;
        const at = transaction.changes.mapPos(transaction.startState.doc.line(line).from, 1);
        moved.set(transaction.state.doc.lineAt(at).number, mark);
      }
      next = { ...next, problems: moved };
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field, marks => (view: EditorView) => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const line of [...marks.problems.keys()].sort((a, b) => a - b)) {
      if (line > view.state.doc.lines || marks.problems.get(line) !== 'syntax') continue;
      const { from } = view.state.doc.line(line);
      builder.add(from, from, syntaxLine);
    }
    return builder.finish();
  }),
});

const syntaxLine = Decoration.line({ class: 'cm-line-syntax' });
const markText: Record<LineMark, string> = { insert: '+', remove: '−', error: '!', warning: '!', syntax: '!' };
const markLabel: Record<LineMark, string> = { insert: 'inserted', remove: 'removed', error: 'error', warning: 'warning', syntax: 'does not parse' };

class MarkGutter extends GutterMarker {
  constructor(readonly mark: LineMark) { super(); }
  override eq(other: GutterMarker) { return other instanceof MarkGutter && other.mark === this.mark; }
  override toDOM() {
    const span = document.createElement('span');
    span.className = `cm-mark cm-mark-${this.mark}`;
    span.textContent = markText[this.mark];
    span.title = markLabel[this.mark];
    return span;
  }
}

const markGutter = gutter({
  class: 'cm-mark-gutter',
  lineMarker(view, line) {
    const number = view.state.doc.lineAt(line.from).number;
    const marks = view.state.field(lineMarks);
    // An error outranks a pending change on the same line.
    const mark = marks.problems.get(number) ?? marks.preview.get(number);
    return mark ? new MarkGutter(mark) : null;
  },
  lineMarkerChange: update => update.startState.field(lineMarks) !== update.state.field(lineMarks),
  initialSpacer: () => new MarkGutter('insert'),
});

// ---- The lit fact -----------------------------------------------------------

/** Lights every use of one identifier, or none. */
export const setLit = StateEffect.define<string | undefined>();

const litName = StateField.define<string | undefined>({
  create: () => undefined,
  update: (value, transaction) => transaction.effects.reduce<string | undefined>((name, effect) => (effect.is(setLit) ? effect.value : name), value),
});

const notCode = new Set(['LineComment', 'BlockComment', 'String', 'RawString', 'Rune']);
const litMark = Decoration.mark({ class: 'cm-lit' });

function litDecorations(state: EditorState): DecorationSet {
  const name = state.field(litName);
  if (!name) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(state);
  const text = state.doc.toString();
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_.])${name.replace(/[^\p{L}\p{N}_]/gu, '')}(?![\\p{L}\\p{N}_])`, 'gu');
  for (const match of text.matchAll(pattern)) {
    const from = match.index;
    if (notCode.has(tree.resolveInner(from, 1).name)) continue;
    builder.add(from, from + name.length, litMark);
  }
  return builder.finish();
}

const litPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = litDecorations(view.state); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.startState.field(litName) !== update.state.field(litName) || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = litDecorations(update.state);
    }
  }
}, { decorations: plugin => plugin.decorations });

// ---- Preview marks ------------------------------------------------------------

/** Shows a preview's inserted ranges and removed text over the preview view's document. */
export const setPreviewMarks = StateEffect.define<PreviewMarks | undefined>();

class Removed extends WidgetType {
  constructor(readonly text: string) { super(); }
  override eq(other: WidgetType) { return other instanceof Removed && other.text === this.text; }
  override toDOM() {
    const del = document.createElement('del');
    del.className = 'cm-del';
    del.textContent = this.text;
    return del;
  }
}

const insertMark = Decoration.mark({ class: 'cm-ins', tagName: 'ins' });

const previewDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setPreviewMarks)) continue;
      const marks = effect.value;
      if (!marks) return Decoration.none;
      const ranges = [
        ...marks.inserted.filter(range => range.to > range.from).map(range => insertMark.range(range.from, range.to)),
        ...marks.removed.map(removed => Decoration.widget({ widget: new Removed(removed.text), side: -1 }).range(removed.at)),
      ];
      return Decoration.set(ranges, true);
    }
    return value.map(transaction.changes);
  },
  provide: field => EditorView.decorations.from(field),
});

// ---- A diagnostic's message at the caret ----------------------------------------

const focusChanged = StateEffect.define<boolean>();

const focused = StateField.define<boolean>({
  create: () => false,
  update: (value, transaction) => transaction.effects.reduce((has, effect) => (effect.is(focusChanged) ? effect.value : has), value),
});

// Lint shows a message on hover. This shows the same message while the caret
// sits in an underlined range, so a keyboard user reads it too.
const caretTooltip = StateField.define<Tooltip | null>({
  create: () => null,
  update(_, transaction) {
    const state = transaction.state;
    if (!state.field(focused)) return null;
    const head = state.selection.main.head;
    const messages: { from: number; message: string; severity: string }[] = [];
    forEachDiagnostic(state, (diagnostic, from, to) => {
      if (head >= from && head <= to) messages.push({ from, message: diagnostic.message, severity: diagnostic.severity });
    });
    if (!messages.length) return null;
    return {
      pos: messages[0]!.from,
      above: false,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-caret-diagnostics';
        for (const { message, severity } of messages) {
          const line = document.createElement('div');
          line.className = `cm-diagnostic cm-diagnostic-${severity}`;
          line.textContent = message;
          dom.append(line);
        }
        return { dom };
      },
    };
  },
  provide: field => showTooltip.from(field),
});

// ---- Theme and highlighting -----------------------------------------------------

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.definitionKeyword, tags.controlKeyword, tags.moduleKeyword], fontWeight: '700' },
  { tag: [tags.lineComment, tags.blockComment], color: 'var(--faint)' },
]);

const theme = EditorView.theme({
  '&': { color: 'var(--fg)', backgroundColor: 'var(--bg)', fontSize: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65', overflowX: 'visible' },
  '.cm-content': { caretColor: 'var(--fg)', padding: '8px 0' },
  '.cm-content ::selection, .cm-line::selection': { backgroundColor: '#444' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--edge)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 2px', minWidth: '26px' },
  '.cm-mark-gutter .cm-gutterElement': { width: '12px', textAlign: 'center', fontWeight: '700' },
  '.cm-mark-insert': { color: 'var(--teal)' },
  '.cm-mark-remove': { color: 'var(--amber)' },
  '.cm-mark-error, .cm-mark-syntax': { color: 'var(--red)' },
  '.cm-mark-warning': { color: 'var(--amber)' },
  '.cm-line-syntax': { textDecoration: 'underline wavy var(--red)', textUnderlineOffset: '3px' },
  '.cm-ins': { color: 'var(--teal)', backgroundColor: 'var(--teal-wash)', textDecoration: 'underline', textUnderlineOffset: '3px' },
  '.cm-ins *': { color: 'var(--teal)' },
  '.cm-del': { color: 'var(--amber)', textDecoration: 'line-through' },
  '.cm-lit, .cm-lit *': { color: 'var(--teal)' },
  '.cm-lit': { textDecoration: 'underline', textDecorationColor: 'var(--teal)', textUnderlineOffset: '3px' },
  '.cm-lintRange': { backgroundImage: 'none', paddingBottom: '0' },
  '.cm-lintRange-error': { textDecoration: 'underline wavy var(--red)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning, .cm-lintRange-info, .cm-lintRange-hint': { textDecoration: 'underline wavy var(--amber)', textUnderlineOffset: '3px' },
  '.cm-lintRange-active': { backgroundColor: 'transparent', outline: '1px solid var(--fg)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--edge)', borderRadius: '0', fontFamily: 'var(--sans)', fontSize: '13px', maxWidth: 'min(420px, calc(100vw - 32px))' },
  '.cm-tooltip-lint, .cm-caret-diagnostics': { padding: '0' },
  '.cm-diagnostic': { padding: '4px 10px 4px 12px', borderLeft: '2px solid var(--amber)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  '.cm-diagnostic-error': { borderLeft: '2px solid var(--red)' },
  '.cm-panels': { backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--rule)' },
  '.cm-panel.cm-panel-lint ul [aria-selected]': { backgroundColor: '#222', backgroundImage: 'none' },
  '.cm-panel button, .cm-panel.cm-panel-lint button': { minHeight: '0', backgroundImage: 'none', border: '1px solid var(--control)', borderRadius: '0', color: 'var(--fg)' },
}, { dark: true });

/**
 * Extensions both views share. `onSave` runs on Ctrl+S or Cmd+S in the
 * buffer; `editable` is false for the preview.
 */
export function baseExtensions(options: { editable: boolean; onSave?: () => void; label: Extension }): Extension[] {
  return [
    // The mark column sits left of the line numbers, as in the mockups.
    markGutter,
    lineNumbers({ formatNumber: (line, state) => String(line + state.field(firstLine) - 1) }),
    firstLine,
    lineMarks,
    litName,
    litPlugin,
    previewDecorations,
    focused,
    caretTooltip,
    EditorView.focusChangeEffect.of((_, focusing) => focusChanged.of(focusing)),
    EditorView.lineWrapping,
    EditorState.tabSize.of(4),
    indentUnit.of('\t'),
    go(),
    syntaxHighlighting(highlight),
    theme,
    options.label,
    ...(options.editable
      ? [
        history(),
        keymap.of([
          { key: 'Mod-s', run: () => { options.onSave?.(); return true; }, preventDefault: true },
          ...defaultKeymap, ...historyKeymap, ...lintKeymap, indentWithTab,
        ]),
      ]
      : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
  ];
}
