// Pan and zoom for the canvas. The viewer's navigation.ts scrolls an SVG whose
// viewBox is fixed when it attaches; the editor's graph changes size on every
// edit and must keep a node in place on screen, which scroll clamping at the
// edges cannot do. So the editor keeps the same gestures (drag to pan, wheel
// to scroll, Ctrl+wheel and pinch to zoom at the pointer, Safari gesture
// events, +/-/0/1) on a plain transform: screen = graph × k + (x, y).
import type { Rect } from './layout';

type Point = { x: number; y: number };

export type Transform = { x: number; y: number; k: number };

/** The zoom that fits `bounds` in a viewport, never above Actual size. */
export function fitZoom(bounds: Rect, width: number, height: number, margin = 16): number {
  if (!width || !height) return 1;
  return Math.min(1, (width - 2 * margin) / bounds.width, (height - 2 * margin) / bounds.height);
}

export class View {
  readonly viewport: HTMLElement;
  #apply: (transform: Transform) => void;
  #onPressed: (fitted: boolean, actual: boolean) => void;
  #bounds: Rect = { x: 0, y: 0, width: 1, height: 1 };
  #transform: Transform = { x: 0, y: 0, k: 1 };
  #fitted = false;
  #pointers = new Map<number, Point>();
  #pan?: { start: Point; last: Point; moved: boolean; pinch?: { distance: number; midpoint: Point } };
  #swallowClick = false;
  #lastPointer?: Point;
  #gestureZoom?: number;

  /**
   * `apply` draws a new transform; `onPressed` reports whether Fit map and
   * Actual size are the current state, for their aria-pressed.
   */
  constructor(viewport: HTMLElement, apply: (transform: Transform) => void, onPressed: (fitted: boolean, actual: boolean) => void) {
    this.viewport = viewport;
    this.#apply = apply;
    this.#onPressed = onPressed;
    this.#listen();
  }

  get transform(): Transform { return this.#transform; }
  get fitted(): boolean { return this.#fitted; }

  /** Graph bounds, for Fit map and the zoom floor. */
  setBounds(bounds: Rect) {
    this.#bounds = bounds;
    if (this.#fitted) this.fit();
  }

  set(transform: Transform, fitted = false) {
    this.#transform = transform;
    this.#fitted = fitted;
    this.#apply(transform);
    this.#onPressed(fitted, Math.abs(transform.k - 1) < 0.001);
  }

  /** Converts a client point to viewport-relative pixels. */
  local(client: Point): Point {
    const rect = this.viewport.getBoundingClientRect();
    return { x: client.x - rect.left - this.viewport.clientLeft, y: client.y - rect.top - this.viewport.clientTop };
  }

  /** Converts a client point to graph units. */
  toGraph(client: Point): Point {
    const at = this.local(client);
    const { x, y, k } = this.#transform;
    return { x: (at.x - x) / k, y: (at.y - y) / k };
  }

  #centre(): Point {
    const rect = this.viewport.getBoundingClientRect();
    return { x: rect.left + this.viewport.clientLeft + this.viewport.clientWidth / 2, y: rect.top + this.viewport.clientTop + this.viewport.clientHeight / 2 };
  }

  #minZoom() {
    return Math.min(0.1, fitZoom(this.#bounds, this.viewport.clientWidth, this.viewport.clientHeight));
  }

  /** Zooms to `k`, keeping the graph point under `anchor` (client coordinates) where it is. */
  zoomTo(k: number, anchor: Point = this.#centre()) {
    const next = Math.max(this.#minZoom(), Math.min(4, k));
    const at = this.local(anchor);
    const { x, y, k: current } = this.#transform;
    const graph = { x: (at.x - x) / current, y: (at.y - y) / current };
    this.set({ x: at.x - graph.x * next, y: at.y - graph.y * next, k: next });
  }

  zoomBy(factor: number, anchor?: Point) { this.zoomTo(this.#transform.k * factor, anchor); }

  fit() {
    const width = this.viewport.clientWidth, height = this.viewport.clientHeight;
    if (!width || !height) return;
    const k = fitZoom(this.#bounds, width, height);
    const b = this.#bounds;
    this.set({ x: (width - b.width * k) / 2 - b.x * k, y: (height - b.height * k) / 2 - b.y * k, k }, true);
  }

  /** Actual size, centred on `rect` when given. */
  actual(rect?: Rect) {
    if (rect) this.set({ ...this.#centred(rect, 1), k: 1 });
    else this.zoomTo(1);
  }

  #centred(rect: Rect, k: number): Point {
    return { x: this.viewport.clientWidth / 2 - (rect.x + rect.width / 2) * k, y: this.viewport.clientHeight / 2 - (rect.y + rect.height / 2) * k };
  }

  /** Pans the smallest distance that brings `rect` fully into view, or centres it when it cannot fit. */
  reveal(rect: Rect, margin = 24) {
    const { x, y, k } = this.#transform;
    const width = this.viewport.clientWidth, height = this.viewport.clientHeight;
    const left = rect.x * k + x, top = rect.y * k + y, right = left + rect.width * k, bottom = top + rect.height * k;
    let dx = 0, dy = 0;
    if (rect.width * k + 2 * margin > width) dx = width / 2 - (left + right) / 2;
    else if (left < margin) dx = margin - left;
    else if (right > width - margin) dx = width - margin - right;
    if (rect.height * k + 2 * margin > height) dy = margin - top;
    else if (top < margin) dy = margin - top;
    else if (bottom > height - margin) dy = height - margin - bottom;
    if (dx || dy) this.set({ x: x + dx, y: y + dy, k }, false);
  }

  panBy(dx: number, dy: number) {
    const { x, y, k } = this.#transform;
    this.set({ x: x + dx, y: y + dy, k });
  }

  #listen() {
    const viewport = this.viewport;
    // Focus can scroll even an overflow: hidden box to reveal an element. The
    // transform does the panning, so undo any scroll.
    viewport.addEventListener('scroll', () => {
      if (viewport.scrollLeft || viewport.scrollTop) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
    });
    new ResizeObserver(() => { if (this.#fitted) this.fit(); }).observe(viewport);

    viewport.addEventListener('wheel', event => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        if (this.#gestureZoom !== undefined) return;
        this.zoomBy(Math.exp(-event.deltaY * unit * 0.01), { x: event.clientX, y: event.clientY });
      } else {
        const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
        const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
        this.panBy(-dx * unit, -dy * unit);
      }
    }, { passive: false });

    // Safari reports trackpad pinch as gesture events instead of Ctrl+wheel.
    viewport.addEventListener('gesturestart', event => { event.preventDefault(); this.#gestureZoom = this.#transform.k; });
    viewport.addEventListener('gesturechange', event => {
      event.preventDefault();
      const scale = (event as unknown as { scale?: number }).scale;
      if (this.#gestureZoom !== undefined && typeof scale === 'number' && scale > 0) this.zoomTo(this.#gestureZoom * scale, this.#lastPointer);
    });
    viewport.addEventListener('gestureend', event => { event.preventDefault(); this.#gestureZoom = undefined; });

    viewport.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' && (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) return;
      // Fact sources drag facts, and controls in the overlays keep their own presses.
      if (event.target instanceof Element && event.target.closest('[data-fact-source], button, input, select, textarea, label, .graph-form')) return;
      const point = { x: event.clientX, y: event.clientY };
      this.#pointers.set(event.pointerId, point);
      if (this.#pointers.size === 1) this.#pan = { start: point, last: point, moved: false };
      else if (this.#pan) {
        const gesture = this.#gesture();
        this.#pan.moved = true;
        if (gesture) this.#pan.pinch = gesture;
      }
    });
    viewport.addEventListener('pointermove', event => { this.#lastPointer = { x: event.clientX, y: event.clientY }; });
    window.addEventListener('pointermove', event => {
      if (!this.#pointers.has(event.pointerId) || !this.#pan) return;
      const point = { x: event.clientX, y: event.clientY };
      this.#pointers.set(event.pointerId, point);
      const pan = this.#pan;
      if (!pan.moved && Math.hypot(point.x - pan.start.x, point.y - pan.start.y) < 5) return;
      if (!pan.moved) {
        pan.moved = true;
        viewport.classList.add('panning');
        // Capture after the threshold, so a plain click keeps its target and focus.
        if (!viewport.hasPointerCapture(event.pointerId)) viewport.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      const gesture = this.#gesture();
      if (pan.pinch && gesture && gesture.distance > 0) {
        this.zoomTo(this.#transform.k * gesture.distance / pan.pinch.distance, gesture.midpoint);
        this.panBy(gesture.midpoint.x - pan.pinch.midpoint.x, gesture.midpoint.y - pan.pinch.midpoint.y);
        pan.pinch = gesture;
      } else if (this.#pointers.size === 1) {
        this.panBy(point.x - pan.last.x, point.y - pan.last.y);
        pan.last = point;
      }
    }, { passive: false });
    const end = (event: PointerEvent) => {
      if (!this.#pointers.delete(event.pointerId)) return;
      if (this.#pan?.moved) this.#swallowClick = true;
      if (this.#pointers.size === 1 && this.#pan) {
        const remaining = [...this.#pointers.values()][0]!;
        this.#pan = { start: remaining, last: remaining, moved: true };
      } else if (!this.#pointers.size) {
        this.#pan = undefined;
        viewport.classList.remove('panning');
      }
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', () => { this.#pointers.clear(); this.#pan = undefined; viewport.classList.remove('panning'); });
    window.addEventListener('pointerdown', () => { this.#swallowClick = false; }, true);
    // Window capture, registered before drag.ts installs its own, so the click
    // that ends a pan never reaches a node or the canvas drop zone.
    window.addEventListener('click', event => {
      if (!this.#swallowClick) return;
      this.#swallowClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  #gesture() {
    const [first, second] = [...this.#pointers.values()];
    if (!first || !second) return undefined;
    return {
      midpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
      distance: Math.hypot(first.x - second.x, first.y - second.y),
    };
  }
}
