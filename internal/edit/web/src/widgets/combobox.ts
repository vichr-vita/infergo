// A filtering picker that follows the ARIA combobox pattern with a listbox
// popup: the text field keeps focus, arrow keys move the active option
// (announced through aria-activedescendant), Enter chooses, Esc closes, typing
// filters. Options that cannot be chosen stay in the list, disabled, with the
// reason beside them. The sheet uses it for Add read, the Facts column for
// requesting an output.
import { h } from '../dom';
import { uniqueId } from './inline';

/** One row of the picker. `note` is the origin for a choosable option and the reason for a disabled one. */
export type ComboOption = { key: string; name: string; type?: string; note: string; disabled?: boolean };

export type ComboboxConfig = {
  label: string;
  placeholder: string;
  /** Shown when nothing matches the typed text. */
  empty: string;
  options(query: string): ComboOption[];
  /** The active option changed: preview it. Undefined when none is active or the active one is disabled. */
  active(option: ComboOption | undefined): void;
  /** Apply the choice. Resolve undefined on success, or the refusal message to keep the picker open. */
  choose(option: ComboOption): Promise<string | undefined>;
  /** Called once when the picker closes, after it left the DOM. `left` means focus moved elsewhere, so do not move it back. */
  closed(how: 'chosen' | 'cancelled' | 'left'): void;
  announce(text: string): void;
};

export type Combobox = { element: HTMLElement; input: HTMLInputElement; refresh(): void; close(): void };

export function combobox(config: ComboboxConfig): Combobox {
  const id = uniqueId('combo');
  const input = h('input', {
    id: `${id}-input`, type: 'text', role: 'combobox', class: 'mono', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off',
    placeholder: config.placeholder, 'aria-expanded': 'true', 'aria-controls': `${id}-list`, 'aria-autocomplete': 'list',
    'aria-describedby': `${id}-message`, enterkeyhint: 'go',
  });
  const list = h('ul', { id: `${id}-list`, role: 'listbox', class: 'combo-list', 'aria-label': config.label });
  const message = h('p', { id: `${id}-message`, class: 'combo-message' });
  const close = h('button', { type: 'button', class: 'mini' }, 'Close');
  const element = h('div', { class: 'combo' },
    h('div', { class: 'combo-head' }, h('label', { for: input.id }, config.label), close), input, list, message);

  let options: ComboOption[] = [];
  let activeKey: string | undefined;
  let open = true;
  let busy = false;

  const optionId = (index: number) => `${id}-option-${index}`;

  function render() {
    options = config.options(input.value.trim());
    if (activeKey !== undefined && !options.some(option => option.key === activeKey)) activeKey = undefined;
    const rows = options.map((option, index) => {
      const li = h('li', {
        id: optionId(index), role: 'option', class: option.disabled ? 'combo-option disabled' : 'combo-option',
        'aria-disabled': option.disabled ? 'true' : undefined, 'aria-selected': String(option.key === activeKey),
      },
      h('span', { class: 'combo-name' }, option.name),
      option.type ? h('span', { class: 'fact-type' }, option.type) : undefined,
      h('span', { class: option.disabled ? 'combo-note text-refused' : 'combo-note' }, option.note));
      li.dataset.key = option.key;
      return li;
    });
    list.replaceChildren(...rows);
    message.textContent = options.length ? '' : config.empty;
    const index = options.findIndex(option => option.key === activeKey);
    if (index >= 0) input.setAttribute('aria-activedescendant', optionId(index));
    else input.removeAttribute('aria-activedescendant');
  }

  function activate(key: string | undefined) {
    if (key === activeKey) return;
    activeKey = key;
    for (const li of list.children) li.setAttribute('aria-selected', String((li as HTMLElement).dataset.key === key));
    const index = options.findIndex(option => option.key === key);
    if (index >= 0) {
      input.setAttribute('aria-activedescendant', optionId(index));
      list.children[index]?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
    const option = options[index];
    config.active(option && !option.disabled ? option : undefined);
  }

  function finish(how: 'chosen' | 'cancelled' | 'left') {
    if (!open) return;
    open = false;
    config.active(undefined);
    element.remove();
    config.closed(how);
  }

  async function choose(option: ComboOption | undefined) {
    if (!option || busy) return;
    if (option.disabled) {
      message.textContent = `${option.name}: ${option.note}.`;
      config.announce(message.textContent);
      return;
    }
    busy = true;
    element.setAttribute('aria-busy', 'true');
    const refusal = await config.choose(option);
    busy = false;
    element.removeAttribute('aria-busy');
    if (refusal) {
      message.textContent = refusal;
      config.announce(refusal);
      return;
    }
    finish('chosen');
  }

  input.addEventListener('input', () => {
    render();
    // With text typed, the first choosable match becomes active, so Enter
    // takes it and the code pane already shows it.
    const first = input.value.trim() ? options.find(option => !option.disabled) : undefined;
    activeKey = undefined;
    activate(first?.key);
    if (!first) config.active(undefined);
  });
  input.addEventListener('keydown', event => {
    const index = options.findIndex(option => option.key === activeKey);
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!options.length) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = index < 0 ? (step > 0 ? 0 : options.length - 1) : (index + step + options.length) % options.length;
        activate(options[next]!.key);
        return;
      }
      case 'PageDown':
      case 'PageUp': {
        event.preventDefault();
        if (!options.length) return;
        const next = Math.max(0, Math.min(options.length - 1, (index < 0 ? 0 : index) + (event.key === 'PageDown' ? 8 : -8)));
        activate(options[next]!.key);
        return;
      }
      case 'Enter':
        event.preventDefault();
        void choose(options[index]);
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        finish('cancelled');
        return;
    }
  });
  // Pressing an option must not move focus out of the field.
  list.addEventListener('pointerdown', event => event.preventDefault());
  list.addEventListener('pointermove', event => {
    const li = (event.target as Element).closest<HTMLElement>('[role="option"]');
    if (li && event.pointerType === 'mouse') activate(li.dataset.key);
  });
  list.addEventListener('click', event => {
    const li = (event.target as Element).closest<HTMLElement>('[role="option"]');
    if (!li) return;
    activate(li.dataset.key);
    void choose(options.find(option => option.key === li.dataset.key));
  });
  close.addEventListener('click', () => finish('cancelled'));
  element.addEventListener('focusout', event => {
    const next = event.relatedTarget;
    if (busy || (next instanceof Node && element.contains(next))) return;
    // Focus left for good (Tab, or a press elsewhere): close without stealing it back.
    setTimeout(() => { if (open && !element.contains(document.activeElement)) finish('left'); }, 0);
  });

  render();
  return { element, input, refresh: render, close: () => finish('cancelled') };
}
