// Small DOM helpers every region may use. The focus rule (README.md, "Focus
// rule") is what they exist for: a redraw updates elements in place and never
// replaces the element that has focus.

type Child = Node | string | false | null | undefined;
type Attributes = Record<string, string | number | boolean | undefined>;

/**
 * Creates an element. `class` sets className; `true` sets an empty attribute;
 * `false` and `undefined` skip it. Falsy children are skipped, so
 * `h('li', {}, pending && '+ ', name)` reads naturally.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name === 'class') element.className = String(value);
    else element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== false && child !== null && child !== undefined && child !== '') element.append(child);
  return element;
}

/** Whether focus is on `element` or inside it. Check this before rebuilding any subtree. */
export function holdsFocus(element: Element): boolean {
  const active = element.ownerDocument.activeElement;
  return !!active && element.contains(active);
}

/** Sets text only when it differs, so an unchanged node is not touched. */
export function setText(element: Element, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

/**
 * Keyed list rendering that obeys the focus rule. Children carry `data-key`.
 * An item whose key exists keeps its element and gets `update`; a new key gets
 * `create` then `update`; keys that disappeared are removed. The element that
 * holds focus is never moved: other elements move around it.
 *
 *   reconcile(list, facts, fact => fact.name, () => h('li'), (li, fact) => setText(li, fact.name));
 */
export function reconcile<T>(
  parent: Element,
  items: readonly T[],
  key: (item: T) => string,
  create: (item: T) => HTMLElement,
  update: (element: HTMLElement, item: T) => void,
) {
  const existing = new Map<string, HTMLElement>();
  for (const child of [...parent.children]) {
    if (child instanceof HTMLElement && child.dataset.key !== undefined) existing.set(child.dataset.key, child);
    else child.remove();
  }
  const wanted: HTMLElement[] = [];
  for (const item of items) {
    const id = key(item);
    let element = existing.get(id);
    if (element) existing.delete(id);
    else {
      element = create(item);
      element.dataset.key = id;
    }
    update(element, item);
    wanted.push(element);
  }
  for (const stale of existing.values()) stale.remove();
  for (let index = 0; index < wanted.length; index++) {
    const element = wanted[index]!;
    let occupant = parent.children[index];
    // Moving a node blurs it, so the focused element stays put and whatever
    // sits in its slot moves to the end, to be placed on a later pass.
    while (occupant && occupant !== element && holdsFocus(element)) {
      parent.append(occupant);
      occupant = parent.children[index];
    }
    if (occupant !== element) parent.insertBefore(element, occupant ?? null);
  }
}
