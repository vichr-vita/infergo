// Small SVG helpers for the canvas. The focus rule applies to SVG too: keyed
// parts keep their elements across renders and are rebuilt only when what
// they draw changed, so a focused node or fact row is never replaced.
const ns = 'http://www.w3.org/2000/svg';

type Attributes = Record<string, string | number | boolean | undefined>;

/** Creates an SVG element. `true` sets an empty attribute; `false` and `undefined` skip it. */
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Attributes = {}, text?: string): SVGElementTagNameMap[K] {
  const element = document.createElementNS(ns, tag);
  setAttributes(element, attributes);
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Sets attributes only where they differ. `false` and `undefined` remove one. */
export function setAttributes(element: Element, attributes: Attributes) {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) {
      if (element.hasAttribute(name)) element.removeAttribute(name);
      continue;
    }
    const text = value === true ? '' : String(value);
    if (element.getAttribute(name) !== text) element.setAttribute(name, text);
  }
}

/** Sets `transform` as a CSS translate, so a change can transition. */
export function moveTo(element: SVGElement | HTMLElement, x: number, y: number) {
  const transform = `translate(${round(x)}px, ${round(y)}px)`;
  if (element.style.transform !== transform) element.style.transform = transform;
}

export const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Keyed children of one parent. Each render calls `begin`, then `part` for
 * every child it wants, then `end`, which removes the children not asked for.
 * A part's `build` runs when it is new or its signature changed.
 */
export class Parts<E extends Element = SVGGElement> {
  readonly parent: Element;
  #items = new Map<string, { element: E; signature: string }>();
  #seen = new Set<string>();
  #create: () => E;

  constructor(parent: Element, create: () => E = () => svg('g') as unknown as E) {
    this.parent = parent;
    this.#create = create;
  }

  begin() { this.#seen.clear(); }

  part(key: string, signature: string, build: (element: E) => void): E {
    let item = this.#items.get(key);
    if (!item) {
      const element = this.#create();
      element.setAttribute('data-key', key);
      this.parent.append(element);
      item = { element, signature: '\u0000' };
      this.#items.set(key, item);
    }
    if (item.signature !== signature) {
      item.signature = signature;
      build(item.element);
    }
    this.#seen.add(key);
    return item.element;
  }

  get(key: string): E | undefined { return this.#items.get(key)?.element; }

  entries(): IterableIterator<[string, { element: E; signature: string }]> { return this.#items.entries(); }

  end() {
    for (const [key, item] of this.#items) {
      if (this.#seen.has(key)) continue;
      item.element.remove();
      this.#items.delete(key);
    }
  }
}
