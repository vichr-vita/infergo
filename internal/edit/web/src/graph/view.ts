// Pan and zoom for the canvas. The viewer's navigation.ts scrolls an SVG whose
// viewBox is fixed when it attaches; the editor's graph changes size on every
// edit and must keep a node in place on screen, which scroll clamping at the
// edges cannot do. So the editor keeps the same gestures (drag to pan, wheel
// to scroll, Ctrl+wheel and pinch to zoom at the pointer, Safari gesture
// events, +/-/0/1) on a plain transform: screen = graph × k + (x, y).
//
// The pure functions below decide how far the view moves; View applies them.
// The only animation frames are a reveal (once, 150 ms) and the edge pan
// while a drag rests near an edge. At rest nothing runs.
import type { Rect } from './layout';

type Point = { x: number; y: number };
type Size = { width: number; height: number };

export type Transform = { x: number; y: number; k: number };

/** The zoom that fits `bounds` in a viewport, never above Actual size. */
export function fitZoom(bounds: Rect, width: number, height: number, margin = 16): number {
  if (!width || !height) return 1;
  return Math.min(1, (width - 2 * margin) / bounds.width, (height - 2 * margin) / bounds.height);
}

/** The transform Fit map shows: the whole graph, centred. */
export function fitTransform(bounds: Rect, width: number, height: number): Transform {
  const k = fitZoom(bounds, width, height);
  return { x: (width - bounds.width * k) / 2 - bounds.x * k, y: (height - bounds.height * k) / 2 - bounds.y * k, k };
}

/** Font size of a node's fact rows, in graph units. graph.css draws them at this size. */
export const rowTextSize = 12;
/** Screen size below which row text stops being readable. */
export const minReadableText = 9;
/** Below this zoom a node draws only its name, at a readable size: 0.75 for 12 px rows. */
export const compactZoom = minReadableText / rowTextSize;

/** Whether nodes draw in their compact form at zoom `k`. */
export function isCompact(k: number): boolean {
  return k < compactZoom - 1e-6;
}

/**
 * The pan that brings `rect` (graph units) fully into a viewport of `size`
 * under `transform`. Zero when it is already fully visible. Otherwise the
 * smallest move that leaves `margin` pixels around it; a rect larger than the
 * viewport is centred across and shows its top.
 */
export function revealShift(rect: Rect, transform: Transform, size: Size, margin = 24): { dx: number; dy: number } {
  const { x, y, k } = transform;
  const { width, height } = size;
  const left = rect.x * k + x, top = rect.y * k + y, right = left + rect.width * k, bottom = top + rect.height * k;
  if (left >= 0 && top >= 0 && right <= width && bottom <= height) return { dx: 0, dy: 0 };
  let dx = 0, dy = 0;
  if (rect.width * k + 2 * margin > width) dx = width / 2 - (left + right) / 2;
  else if (left < margin) dx = margin - left;
  else if (right > width - margin) dx = width - margin - right;
  if (rect.height * k + 2 * margin > height) dy = Math.min(margin, height / 2) - top;
  else if (top < margin) dy = margin - top;
  else if (bottom > height - margin) dy = height - margin - bottom;
  return { dx, dy };
}

/** How the view pans while a drag rests near an edge. */
export const edgePanning = {
  /** Distance inside an edge, in pixels, where panning starts. */
  band: 40,
  /** Distance past an edge, in pixels, where panning stops: the pointer has left for another region. */
  overshoot: 72,
  /** Screen pixels per second at the edge and beyond it. */
  maxSpeed: 600,
  /** Panning stops once the graph's edge is this far inside the viewport. */
  margin: 24,
  /** Speed while the pointer is over a rule that takes the fact, so it stays under the pointer long enough to drop. */
  overTarget: 0.3,
};

/**
 * Panning speed along one axis, in screen pixels per second, for a pointer at
 * `at` in a viewport `length` long. Positive moves the graph towards higher
 * coordinates, which brings what lies before the low edge into view. The speed
 * grows with the square of how deep the pointer is in the band, and is the
 * maximum at the edge and up to `overshoot` past it.
 */
export function edgeSpeed(at: number, length: number, settings = edgePanning): number {
  const { band, overshoot, maxSpeed } = settings;
  const depth = (distance: number) => {
    if (distance < -overshoot || distance >= band) return 0;
    if (distance <= 0) return 1;
    return ((band - distance) / band) ** 2;
  };
  return maxSpeed * (depth(at) - depth(length - at));
}

/**
 * The pan for one frame of `seconds` while a drag's pointer is at `pointer`
 * (viewport pixels), limited so the graph's `bounds` (screen pixels) never
 * moves further than `margin` inside the viewport. Zero means nothing left to pan.
 */
export function edgePan(pointer: Point, size: Size, bounds: Rect, seconds: number, settings = edgePanning): { dx: number; dy: number } {
  const across = (value: number, length: number) => value >= -settings.overshoot && value <= length + settings.overshoot;
  if (!across(pointer.x, size.width) || !across(pointer.y, size.height)) return { dx: 0, dy: 0 };
  const limit = (move: number, low: number, high: number, length: number) => {
    // Moving the graph forward is allowed while its low edge is left of the margin.
    if (move > 0) return Math.max(0, Math.min(move, settings.margin - low));
    if (move < 0) return Math.min(0, Math.max(move, length - settings.margin - high));
    return 0;
  };
  const dx = limit(edgeSpeed(pointer.x, size.width, settings) * seconds, bounds.x, bounds.x + bounds.width, size.width);
  const dy = limit(edgeSpeed(pointer.y, size.height, settings) * seconds, bounds.y, bounds.y + bounds.height, size.height);
  return { dx, dy };
}

/**
 * The first view of a graph: the largest zoom at which `focus` and every rect
 * in `around` (its producers and readers) fit when `focus` is centred,
 * never above Actual size and never below `floor`.
 */
export function openingView(focus: Rect, around: readonly Rect[], size: Size, floor = compactZoom, margin = 24): Transform {
  const cx = focus.x + focus.width / 2, cy = focus.y + focus.height / 2;
  let reachX = focus.width / 2, reachY = focus.height / 2;
  for (const rect of around) {
    reachX = Math.max(reachX, Math.abs(rect.x - cx), Math.abs(rect.x + rect.width - cx));
    reachY = Math.max(reachY, Math.abs(rect.y - cy), Math.abs(rect.y + rect.height - cy));
  }
  const fits = Math.min((size.width / 2 - margin) / reachX, (size.height / 2 - margin) / reachY);
  const k = Math.max(floor, Math.min(1, fits));
  return { x: size.width / 2 - cx * k, y: size.height / 2 - cy * k, k };
}

const near = (a: Transform, b: Transform) => Math.abs(a.k - b.k) < 1e-3 && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class View {
  readonly viewport: HTMLElement;
  #apply: (transform: Transform) => void;
  #onPressed: (fitted: boolean, actual: boolean) => void;
  #bounds: Rect = { x: 0, y: 0, width: 1, height: 1 };
  #transform: Transform = { x: 0, y: 0, k: 1 };
  /** True after Fit map until the next other move, so a resize or a new graph fits again. */
  #fitted = false;
  #pointers = new Map<number, Point>();
  #pan?: { start: Point; last: Point; moved: boolean; pinch?: { distance: number; midpoint: Point } };
  #swallowClick = false;
  #lastPointer?: Point;
  #gestureZoom?: number;
  #glide?: number;
  #edge?: { frame: number; last?: number };

  /**
   * `apply` draws a new transform; `onPressed` reports whether the view is
   * exactly Fit map and whether it is at Actual size, for their aria-pressed.
   */
  constructor(viewport: HTMLElement, apply: (transform: Transform) => void, onPressed: (fitted: boolean, actual: boolean) => void) {
    this.viewport = viewport;
    this.#apply = apply;
    this.#onPressed = onPressed;
    this.#listen();
  }

  get transform(): Transform { return this.#transform; }
  get fitted(): boolean { return this.#fitted; }
  get size(): Size { return { width: this.viewport.clientWidth, height: this.viewport.clientHeight }; }

  /** Graph bounds, for Fit map and the zoom floor. */
  setBounds(bounds: Rect) {
    this.#bounds = bounds;
    if (this.#fitted) this.fit();
    else this.#report();
  }

  /** Moves the view at once. Any move stops a reveal that is still gliding. */
  set(transform: Transform, fitted = false) {
    this.#stopGlide();
    this.#show(transform, fitted);
  }

  #show(transform: Transform, fitted: boolean) {
    this.#transform = transform;
    this.#fitted = fitted;
    this.#apply(transform);
    this.#report();
  }

  #report() {
    const { width, height } = this.size;
    const fit = width && height ? fitTransform(this.#bounds, width, height) : undefined;
    this.#onPressed(!!fit && near(this.#transform, fit), Math.abs(this.#transform.k - 1) < 1e-3);
  }

  /** Glides to `transform` over 150 ms, or jumps there when the user prefers reduced motion. */
  glideTo(transform: Transform) {
    this.#stopGlide();
    const from = this.#transform;
    if (reducedMotion() || typeof requestAnimationFrame !== 'function') { this.#show(transform, false); return; }
    let start: number | undefined;
    const step = (now: number) => {
      start ??= now;
      const t = Math.min(1, (now - start) / 150);
      const ease = 1 - (1 - t) ** 3;
      this.#show({ x: from.x + (transform.x - from.x) * ease, y: from.y + (transform.y - from.y) * ease, k: from.k + (transform.k - from.k) * ease }, false);
      this.#glide = t < 1 ? requestAnimationFrame(step) : undefined;
    };
    this.#glide = requestAnimationFrame(step);
  }

  #stopGlide() {
    if (this.#glide === undefined) return;
    cancelAnimationFrame(this.#glide);
    this.#glide = undefined;
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
    const { width, height } = this.size;
    if (!width || !height) return;
    this.set(fitTransform(this.#bounds, width, height), true);
  }

  /** Actual size, centred on `rect` when given. */
  actual(rect?: Rect) {
    if (rect) this.set({ ...this.#centred(rect, 1), k: 1 });
    else this.zoomTo(1);
  }

  #centred(rect: Rect, k: number): Point {
    return { x: this.viewport.clientWidth / 2 - (rect.x + rect.width / 2) * k, y: this.viewport.clientHeight / 2 - (rect.y + rect.height / 2) * k };
  }

  /** Brings `rect` fully into view by the smallest pan, gliding there; does nothing when it is already in view. */
  reveal(rect: Rect, margin = 24) {
    const { dx, dy } = revealShift(rect, this.#transform, this.size, margin);
    if (!dx && !dy) return;
    const { x, y, k } = this.#transform;
    this.glideTo({ x: x + dx, y: y + dy, k });
  }

  panBy(dx: number, dy: number) {
    const { x, y, k } = this.#transform;
    this.set({ x: x + dx, y: y + dy, k });
  }

  /**
   * Starts panning towards the edge the pointer rests near, while `pointer`
   * returns the drag's client point. Each frame calls `moved`, so the caller can
   * aim at whatever is now under the still pointer, and slows down while
   * `overTarget` says that is a rule that takes the fact. The loop stops by
   * itself when the drag ends, the pointer leaves the edge band, or the
   * graph's edge is in view, so no frames run at rest.
   */
  edgePan(pointer: () => Point | undefined, moved: () => void, from: Point, overTarget: () => boolean = () => false) {
    if (this.#edge || typeof requestAnimationFrame !== 'function' || !this.#edgeStep(from, 1 / 60, true)) return;
    const edge: { frame: number; last?: number } = { frame: 0 };
    const step = (now: number) => {
      const client = pointer();
      if (!client) { this.#edge = undefined; return; }
      const elapsed = edge.last === undefined ? 1 / 60 : Math.min(0.05, (now - edge.last) / 1000);
      const seconds = elapsed * (overTarget() ? edgePanning.overTarget : 1);
      edge.last = now;
      if (!this.#edgeStep(client, seconds, false)) { this.#edge = undefined; return; }
      moved();
      edge.frame = requestAnimationFrame(step);
    };
    this.#edge = edge;
    edge.frame = requestAnimationFrame(step);
  }

  /** One frame of edge panning for a pointer at `client`. Returns false when there is nothing to pan. */
  #edgeStep(client: Point, seconds: number, dryRun: boolean): boolean {
    const size = this.size;
    if (!size.width || !size.height) return false;
    const { x, y, k } = this.#transform;
    const b = this.#bounds;
    const bounds = { x: b.x * k + x, y: b.y * k + y, width: b.width * k, height: b.height * k };
    const { dx, dy } = edgePan(this.local(client), size, bounds, seconds);
    if (!dx && !dy) return false;
    if (!dryRun) this.panBy(dx, dy);
    return true;
  }

  #listen() {
    const viewport = this.viewport;
    // Focus can scroll even an overflow: hidden box to reveal an element. The
    // transform does the panning, so undo any scroll.
    viewport.addEventListener('scroll', () => {
      if (viewport.scrollLeft || viewport.scrollTop) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
    });
    new ResizeObserver(() => { if (this.#fitted) this.fit(); else this.#report(); }).observe(viewport);

    viewport.addEventListener('wheel', event => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        if (this.#gestureZoom !== undefined) return;
        // A trackpad pinch sends small deltas; a mouse notch sends 100 or more,
        // which is capped so one notch zooms about 1.28 times rather than 3.
        const delta = Math.max(-25, Math.min(25, event.deltaY * unit));
        this.zoomBy(Math.exp(-delta * 0.01), { x: event.clientX, y: event.clientY });
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
