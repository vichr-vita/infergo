// Helpers the Facts column, the rule sheet, the list view, and History share
// for turning a control into an operation: preview on hover and focus, apply
// and wait for the model that results, so the caller can place focus on an
// element that now exists.
import type { Result } from '../api';
import { h } from '../dom';
import type { ApplyReply, Fix, Op } from '../protocol';
import type { Store } from '../store';

/**
 * Resolves once the store holds a model at least as new as `revision`. The
 * server may answer an apply before the event stream delivers the model, so a
 * caller that focuses a new row waits for this first. Gives up after 3 s.
 */
export function untilRevision(store: Store, revision: number): Promise<void> {
  if (store.state.model.revision >= revision) return Promise.resolve();
  return new Promise(resolve => {
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => { stop?.(); resolve(); }, 3000);
    stop = store.watch(s => s.model.revision, current => {
      if (current < revision) return;
      clearTimeout(timer);
      stop?.();
      resolve();
    }, { immediate: false });
  });
}

/** Clears the op's preview, applies it, and on success waits for the new model. */
export async function applyAndSettle(store: Store, op: Op): Promise<Result<ApplyReply>> {
  store.clearPreview(op);
  const result = await store.apply(op);
  if (result.kind === 'ok') await untilRevision(store, result.value.revision);
  return result;
}

/** Steps undo or redo and waits for the model, like applyAndSettle. */
export async function stepAndSettle(store: Store, direction: 'undo' | 'redo'): Promise<Result<ApplyReply>> {
  const result = await (direction === 'undo' ? store.undo() : store.redo());
  if (result.kind === 'ok') await untilRevision(store, result.value.revision);
  return result;
}

/** The sentence for a failed request, or undefined on success. */
export function failureText(result: Result<unknown>): string | undefined {
  if (result.kind === 'refused') return result.refusal.message;
  if (result.kind === 'failed') return result.error;
  return undefined;
}

/**
 * Shows the op's diff while the pointer rests on `control` or it has focus,
 * and clears it on leave and blur. `op` is read at event time, so a reused
 * element always previews its current meaning; undefined previews nothing.
 */
export function previewWhileAimed(control: HTMLElement, store: Store, op: () => Op | undefined) {
  let shown: Op | undefined;
  const show = () => {
    if (control.getAttribute('aria-disabled') === 'true') return;
    shown = op();
    if (shown) store.previewOp(shown);
  };
  const hide = () => {
    if (shown) store.clearPreview(shown);
    shown = undefined;
  };
  control.addEventListener('pointerenter', show);
  control.addEventListener('focus', show);
  control.addEventListener('pointerleave', () => { if (document.activeElement !== control) hide(); });
  control.addEventListener('blur', hide);
}

/**
 * A fix link: previews on hover and focus, applies on click. `after` runs once
 * the fix landed or failed, so the caller can move focus off a link that the
 * next check will remove.
 */
export function fixButton(store: Store, fix: Fix, after?: (result: Result<ApplyReply>) => void): HTMLButtonElement {
  const button = h('button', { type: 'button', class: 'fix' }, fix.label);
  previewWhileAimed(button, store, () => fix.op);
  button.addEventListener('click', () => {
    void applyAndSettle(store, fix.op).then(result => after?.(result));
  });
  return button;
}

/** Whether a key event carries no modifier, so a single-letter shortcut may act. */
export function plainKey(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing;
}

/** Whether keys typed at this target belong to a text field rather than the page. */
export function typingTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'submit', 'reset'].includes(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}
