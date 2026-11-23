// The canvas's inline forms: New rule, rename a rule or fact, and the one
// question before deleting a rule. One form is open at a time, in an unscaled
// layer over the canvas, so it stays readable at any zoom. Enter submits, Esc
// cancels, and a refusal from the server is shown where the input is.
import { addRuleOp, suggestedResult } from '../derive';
import { h } from '../dom';
import type { Fact, Op } from '../protocol';
import type { Store } from '../store';

type Point = { x: number; y: number };
/** Where a form goes, given its size once it is laid out. */
type Placer = (size: { width: number; height: number }) => Point;

/** What the New rule form holds so far, for the placeholder node the canvas draws. */
export type Draft = { name: string; result: string; type: string };

const goKeywords = new Set(['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var']);

/** Why `name` cannot name a new or renamed rule, or undefined when it can. */
export function ruleNameProblem(name: string, taken: (name: string) => boolean): string | undefined {
  if (!name) return 'Enter a rule name.';
  if (!/^\p{Lu}[\p{L}\p{N}_]*$/u.test(name)) return `${name} is not an exported Go name. Start with a capital letter and use only letters, digits, and _.`;
  if (taken(name)) return `A rule named ${name} already exists.`;
  return undefined;
}

/** Why `name` cannot name a fact, or undefined when it can. */
export function factNameProblem(name: string): string | undefined {
  if (!name) return 'Enter a fact name.';
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) || goKeywords.has(name)) return `${name} is not a Go name.`;
  return undefined;
}

export class Forms {
  readonly layer: HTMLElement;
  #store: Store;
  #returnFocus: () => void;
  #open?: { element: HTMLElement; previewed?: Op; onClose?: () => void };

  /** `returnFocus` puts focus back on the canvas when a form that had it closes. */
  constructor(layer: HTMLElement, store: Store, returnFocus: () => void) {
    this.layer = layer;
    this.#store = store;
    this.#returnFocus = returnFocus;
  }

  get isOpen(): boolean { return !!this.#open; }

  close(returnFocus = true) {
    const open = this.#open;
    if (!open) return;
    this.#open = undefined;
    const hadFocus = open.element.contains(document.activeElement);
    if (open.previewed) this.#store.clearPreview(open.previewed);
    open.element.remove();
    open.onClose?.();
    if (hadFocus && returnFocus) this.#returnFocus();
  }

  #mount(form: HTMLElement, at: Point | Placer, focus: HTMLElement, onClose?: () => void) {
    this.close(false);
    this.#open = { element: form, onClose };
    form.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    });
    this.layer.append(form);
    // Keep the whole form inside the canvas.
    const width = this.layer.clientWidth, height = this.layer.clientHeight;
    const point = typeof at === 'function' ? at({ width: form.offsetWidth, height: form.offsetHeight }) : at;
    const x = Math.max(8, Math.min(point.x, width - form.offsetWidth - 8));
    const y = Math.max(8, Math.min(point.y, height - form.offsetHeight - 8));
    form.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    focus.focus({ preventScroll: true });
    if (focus instanceof HTMLInputElement) focus.select();
  }

  #preview(op: Op | undefined) {
    const open = this.#open;
    if (!open) return;
    if (open.previewed && (!op || JSON.stringify(op) !== JSON.stringify(open.previewed))) this.#store.clearPreview(open.previewed);
    open.previewed = op;
    if (op) this.#store.previewOp(op);
  }

  /**
   * The New rule form at `at` (canvas pixels, or a function of the form's
   * size). A fact dropped on the canvas becomes the rule's read. The code pane
   * previews the stub while the form is valid. `created` runs with the new
   * rule's name after the server accepts it. `draft` hears every change to the
   * fields and `closed` the form going away, for the placeholder node.
   */
  newRule(at: Point | Placer, read: Fact | undefined, created: (name: string) => void, draft?: { changed(draft: Draft): void; closed(): void }) {
    const store = this.#store;
    const types = [...new Set([...store.state.graph.facts.values()].map(fact => fact.type))].sort();
    const id = `graph-new-${Date.now().toString(36)}`;
    const name = h('input', { id: `${id}-name`, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${id}-error` });
    const result = h('input', { id: `${id}-result`, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Result name', 'aria-describedby': `${id}-error` });
    const type = h('input', { id: `${id}-type`, autocomplete: 'off', spellcheck: 'false', list: `${id}-types`, 'aria-label': 'Result type', value: read?.type ?? 'bool' });
    const datalist = h('datalist', { id: `${id}-types` }, ...types.map(value => h('option', { value })));
    const error = h('p', { id: `${id}-error`, class: 'graph-form-error text-error', 'aria-live': 'polite' });
    const create = h('button', { type: 'submit', class: 'graph-form-primary' }, 'Create rule');
    const cancel = h('button', { type: 'button' }, 'Cancel');
    const form = h('form', { class: 'graph-form graph-new-rule', 'aria-label': 'New rule', novalidate: true },
      h('label', { for: name.id }, 'Rule name'), name,
      read ? h('p', { class: 'graph-form-read pending' }, 'Reads ', h('span', { class: 'mono' }, `+ ${read.name} ${read.type}`)) : false,
      h('label', { for: result.id }, 'Produces'),
      h('div', { class: 'graph-form-pair' }, result, type), datalist,
      error,
      h('div', { class: 'graph-form-actions' }, create, cancel),
    );
    let resultEdited = false;

    const problem = (): string | undefined => {
      const graph = store.state.graph;
      const ruleProblem = ruleNameProblem(name.value.trim(), candidate => graph.rules.has(candidate));
      if (ruleProblem) return ruleProblem;
      const fact = result.value.trim();
      const factProblem = factNameProblem(fact);
      if (factProblem) return factProblem;
      if (read && fact === read.name) return `The rule cannot read and produce ${fact}.`;
      const producer = graph.facts.get(fact)?.producers[0];
      if (producer) return `${fact} is already produced by ${producer}.`;
      if (graph.facts.get(fact)?.input) return `${fact} is an input.`;
      if (!type.value.trim()) return 'Enter a type.';
      return undefined;
    };
    const op = (): Op => addRuleOp(store.state.graph, name.value.trim(), [{ name: result.value.trim(), type: type.value.trim() }], read);
    const refresh = (showError: boolean) => {
      draft?.changed({ name: name.value.trim(), result: result.value.trim(), type: type.value.trim() });
      const why = problem();
      error.textContent = showError && name.value ? why ?? '' : '';
      name.setAttribute('aria-invalid', String(!!why && showError && !!name.value));
      this.#preview(why ? undefined : op());
    };

    name.addEventListener('input', () => {
      if (!resultEdited) result.value = name.value.trim() ? suggestedResult(name.value.trim()) : '';
      refresh(true);
    });
    result.addEventListener('input', () => { resultEdited = true; refresh(true); });
    type.addEventListener('input', () => refresh(true));
    cancel.addEventListener('click', () => this.close());
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const why = problem();
      if (why) { error.textContent = why; name.setAttribute('aria-invalid', 'true'); return; }
      const request = op();
      create.disabled = true;
      const outcome = await store.apply(request);
      create.disabled = false;
      if (outcome.kind === 'ok') {
        const ruleName = name.value.trim();
        this.close(false);
        created(ruleName);
      } else {
        error.textContent = outcome.kind === 'refused' ? outcome.refusal.message : outcome.error;
      }
    });
    this.#mount(form, at, name, draft?.closed);
    draft?.changed({ name: '', result: '', type: type.value.trim() });
  }

  /** An input over a rule's name or a fact row. Enter applies rename_rule or rename_fact. */
  rename(kind: 'rule' | 'fact', current: string, at: Point, width: number, renamed: (name: string) => void) {
    const store = this.#store;
    const id = `graph-rename-${Date.now().toString(36)}`;
    const input = h('input', {
      id, autocomplete: 'off', spellcheck: 'false', value: current, 'aria-describedby': `${id}-error`,
      'aria-label': kind === 'rule' ? `Rename rule ${current}` : `Rename fact ${current}`,
    });
    const error = h('p', { id: `${id}-error`, class: 'graph-form-error text-error', 'aria-live': 'polite' });
    const form = h('form', { class: `graph-form graph-rename graph-rename-${kind}`, 'aria-label': kind === 'rule' ? 'Rename rule' : 'Rename fact', novalidate: true },
      input, error, h('p', { class: 'graph-form-keys' }, 'Enter renames everywhere. Esc cancels.'));
    form.style.width = `${Math.max(240, Math.round(width))}px`;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const to = input.value.trim();
      if (to === current) { this.close(); return; }
      const why = kind === 'rule' ? ruleNameProblem(to, candidate => store.state.graph.rules.has(candidate)) : factNameProblem(to);
      if (why) { error.textContent = why; input.setAttribute('aria-invalid', 'true'); return; }
      const op: Op = kind === 'rule' ? { op: 'rename_rule', rule: current, to } : { op: 'rename_fact', fact: current, to };
      const outcome = await store.apply(op);
      if (outcome.kind === 'ok') { this.close(false); renamed(to); return; }
      error.textContent = outcome.kind === 'refused' ? outcome.refusal.message : outcome.error;
      input.setAttribute('aria-invalid', 'true');
      input.focus({ preventScroll: true });
    });
    input.addEventListener('input', () => { error.textContent = ''; input.removeAttribute('aria-invalid'); });
    // Leaving the field without Enter cancels, as an inline rename does elsewhere.
    form.addEventListener('focusout', event => {
      if (event.relatedTarget instanceof Node && form.contains(event.relatedTarget)) return;
      queueMicrotask(() => { if (this.#open?.element === form && !form.contains(document.activeElement)) this.close(false); });
    });
    this.#mount(form, at, input);
  }

  /** Asks once before delete_rule. The code pane previews the removal while the question is open. */
  confirmDelete(rule: string, at: Point, deleted: () => void) {
    const store = this.#store;
    const op: Op = { op: 'delete_rule', rule };
    const remove = h('button', { type: 'submit', class: 'graph-form-danger' }, `Delete ${rule}`);
    const cancel = h('button', { type: 'button' }, 'Cancel');
    const error = h('p', { class: 'graph-form-error text-error', 'aria-live': 'polite' });
    const form = h('form', { class: 'graph-form graph-confirm', role: 'alertdialog', 'aria-label': `Delete ${rule}` },
      h('p', {}, `Delete ${rule}? Its doc comment and declaration are removed. Undo brings them back.`),
      error,
      h('div', { class: 'graph-form-actions' }, remove, cancel));
    cancel.addEventListener('click', () => this.close());
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const outcome = await store.apply(op);
      // Focus returns to the canvas, which moves it to a remaining rule once the node is gone.
      if (outcome.kind === 'ok') { this.close(); deleted(); return; }
      error.textContent = outcome.kind === 'refused' ? outcome.refusal.message : outcome.error;
    });
    this.#mount(form, at, remove);
    this.#preview(op);
  }
}
