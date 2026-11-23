// Inline forms that open in place of what they edit: a single name field for
// renames, and a two-step confirmation for deletes. Each moves focus into
// itself on open and tells its caller how it closed, so the caller returns
// focus to the opener or to the element the operation created.
import { h } from '../dom';

let counter = 0;
/** A page-unique id for wiring labels and descriptions. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${++counter}`;
}

export type InlineNameOptions = {
  /** Visible label above the field, such as "Rename employeeID". */
  label: string;
  value: string;
  /** Text of the submit button, such as "Rename". */
  action: string;
  /** Local check; a message keeps the form open and shows beside the field. */
  validate(value: string): string | undefined;
  /** Sends the operation. Resolve undefined on success or the refusal message. */
  submit(value: string): Promise<string | undefined>;
  /** Called once when the form closes, after it left the DOM. `left` means focus moved elsewhere, so do not move it back. */
  closed(how: 'applied' | 'cancelled' | 'unchanged' | 'left'): void;
  /** Speaks a local refusal. */
  announce(text: string): void;
};

export type InlineName = { element: HTMLElement; input: HTMLInputElement; close(): void };

/**
 * Builds a rename form. Enter applies, Esc cancels, an unchanged value closes
 * quietly. A refusal shows next to the field, is announced, and leaves the
 * form open. Insert `element` where the name was and call `input.focus()`.
 */
export function inlineName(options: InlineNameOptions): InlineName {
  const id = uniqueId('inline');
  const input = h('input', {
    id, type: 'text', class: 'inline-input mono', value: options.value, autocomplete: 'off', spellcheck: 'false',
    autocapitalize: 'off', 'aria-describedby': `${id}-message`, enterkeyhint: 'done',
  });
  const message = h('span', { id: `${id}-message`, class: 'inline-message text-refused' });
  const save = h('button', { type: 'submit', class: 'mini' }, options.action);
  const cancel = h('button', { type: 'button', class: 'mini' }, 'Cancel');
  const form = h('form', { class: 'inline-form', novalidate: true },
    h('label', { for: id }, options.label), input, h('span', { class: 'inline-actions' }, save, cancel), message);
  let busy = false;
  let open = true;

  const close = (how: 'applied' | 'cancelled' | 'unchanged' | 'left') => {
    if (!open) return;
    open = false;
    form.remove();
    options.closed(how);
  };
  const refuse = (text: string) => {
    message.textContent = text;
    input.setAttribute('aria-invalid', 'true');
    options.announce(text);
  };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const value = input.value.trim();
    if (value === options.value) { close('unchanged'); return; }
    const problem = options.validate(value);
    if (problem) { refuse(problem); return; }
    busy = true;
    form.setAttribute('aria-busy', 'true');
    const refusal = await options.submit(value);
    busy = false;
    form.removeAttribute('aria-busy');
    if (refusal) { refuse(refusal); input.focus(); return; }
    close('applied');
  });
  input.addEventListener('input', () => {
    if (!message.textContent) return;
    message.textContent = '';
    input.removeAttribute('aria-invalid');
  });
  form.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close('cancelled');
  });
  cancel.addEventListener('click', () => close('cancelled'));
  // Leaving an untouched form closes it; one with an edit or a refusal stays
  // so the work is not lost.
  form.addEventListener('focusout', event => {
    const next = event.relatedTarget;
    if (busy || (next instanceof Node && form.contains(next))) return;
    setTimeout(() => {
      if (form.contains(document.activeElement) || input.value.trim() !== options.value || message.textContent) return;
      close('left');
    }, 0);
  });
  return { element: form, input, close: () => close('cancelled') };
}

export type ConfirmOptions = {
  question: string;
  confirm: string;
  /** Called with the confirm button so the caller can attach a preview. */
  decorate?(button: HTMLButtonElement): void;
  submit(): Promise<string | undefined>;
  closed(how: 'applied' | 'cancelled'): void;
  announce(text: string): void;
};

/**
 * An inline "are you sure" with a confirm and a Keep button. Focus starts on
 * Keep, so a stray Enter does not delete. Esc keeps.
 */
export function inlineConfirm(options: ConfirmOptions): { element: HTMLElement; focus(): void; close(): void } {
  const id = uniqueId('confirm');
  const yes = h('button', { type: 'button', class: 'mini danger' }, options.confirm);
  const no = h('button', { type: 'button', class: 'mini' }, 'Keep');
  const message = h('span', { class: 'inline-message text-refused' });
  const element = h('div', { class: 'inline-confirm', role: 'group', 'aria-labelledby': id },
    h('span', { id }, options.question), h('span', { class: 'inline-actions' }, yes, no), message);
  options.decorate?.(yes);
  let open = true;
  const close = (how: 'applied' | 'cancelled') => {
    if (!open) return;
    open = false;
    element.remove();
    options.closed(how);
  };
  yes.addEventListener('click', async () => {
    const refusal = await options.submit();
    if (refusal) { message.textContent = refusal; options.announce(refusal); return; }
    close('applied');
  });
  no.addEventListener('click', () => close('cancelled'));
  element.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close('cancelled');
  });
  return { element, focus: () => no.focus(), close: () => close('cancelled') };
}
