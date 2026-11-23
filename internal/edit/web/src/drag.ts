// Pointer wiring shared by every region, so a fact can be picked up in one
// region and dropped in another. Regions never hit-test each other's DOM.
// They mark their elements with data attributes and this module does the rest.
//
// Sources: an element that can be picked up calls beginDrag from its
// pointerdown handler. It must not capture the pointer.
//
//   row.addEventListener('pointerdown', event => beginDrag(event, 'financeRequired', store));
//
// A press that moves less than the threshold stays a click: the fact is held
// (click then click). A press that moves becomes a drag: a label follows the
// pointer and releasing drops or cancels.
//
// Targets, found with closest() on the element under the pointer:
//
//   data-drop-rule="RuleId"    a rule that may take the held fact. While a fact
//                              is held, moving over it aims and leaving it aims
//                              at nothing. Releasing a drag on it, or clicking
//                              it in click then click mode, drops.
//   data-drop-zone="canvas"    empty graph canvas. A drop dispatches the
//                              bubbling CustomEvent 'infergo:drop' on it.
//   data-drop-zone="outputs"   the Outputs section. Same event.
//
// The event's detail is a ZoneDrop. The region that owns the zone decides what
// the drop means (the graph opens its new rule form, the Facts column requests
// the output). The fact has already been put down when the event fires.
//
// Releasing a drag anywhere else cancels. A click outside any target while a
// fact is held in click then click mode leaves it held; Esc cancels (main.ts).
//
// Workstream F owns the implementation. The signatures are fixed.
//
// Implementation notes, not part of the contract above:
// - While a drag is over a drop zone, that zone carries `data-drop-over`, so
//   its region can outline it.
// - Touch: the browser decides whether a touch scrolls when the press starts,
//   so a source that should drag on touch sets `touch-action: none` in its own
//   CSS. A press the browser takes over for scrolling ends in pointercancel,
//   which puts down only what this press picked up.
// - beginDragOnly is for a source whose click already means something else
//   (a wire label selects its wire): a drag picks the fact up, a click does not.
import type { Store } from './store';

/** Detail of the 'infergo:drop' event dispatched on a data-drop-zone element. */
export type ZoneDrop = { fact: string; zone: string; clientX: number; clientY: number };

/** Distance in CSS pixels a press must travel before it counts as a drag rather than a click. */
export const dragThreshold = 4;

type Point = { x: number; y: number };

/** Whether a press that started at `start` and is now at `point` has become a drag. */
export function pastThreshold(start: Point, point: Point, threshold = dragThreshold): boolean {
  return Math.hypot(point.x - start.x, point.y - start.y) >= threshold;
}

/**
 * What releasing a press that never crossed the threshold does. Clicking the
 * fact that is already held by a click puts it down ("click the fact again"),
 * clicking any other fact picks that one up, and a source whose click means
 * something else does nothing.
 */
export function clickOutcome(press: { fact: string; clickHolds: boolean; heldFact?: string; heldByClick: boolean }): 'hold' | 'put-down' | 'none' {
  if (!press.clickHolds) return 'none';
  if (press.heldByClick && press.heldFact === press.fact) return 'put-down';
  return 'hold';
}

type Session = {
  pointerId: number;
  fact: string;
  start: Point;
  clickHolds: boolean;
  dragging: boolean;
  /** True when this press picked the fact up, so a cancelled press puts down only its own hold. */
  pickedUp: boolean;
};

// Module state. There is one pointer wiring per page; installPointerWiring
// sets the document listeners once.
let session: Session | undefined;
/** True while the held fact was picked up by a pointer click, so hovering aims and clicking it again puts it down. */
let heldByClick = false;
/** Set after a drag or a handled press, so the click the browser sends next does not act a second time. */
let swallowClick = false;
let label: HTMLElement | undefined;
let overZone: Element | undefined;
let savedStyles: { userSelect: string; webkitUserSelect: string; cursor: string; touchAction: string } | undefined;

/** Call from a source's pointerdown handler to pick the fact up by click or drag. */
export function beginDrag(event: PointerEvent, fact: string, store: Store): void {
  start(event, fact, store, true);
}

/** Like beginDrag, for a source whose click does something else: only a drag picks the fact up. */
export function beginDragOnly(event: PointerEvent, fact: string, store: Store): void {
  start(event, fact, store, false);
}

function start(event: PointerEvent, fact: string, store: Store, clickHolds: boolean) {
  if (!event.isPrimary) return;
  if (event.pointerType === 'mouse' && (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey)) return;
  void store; // the store installPointerWiring was given carries the gesture
  session = { pointerId: event.pointerId, fact, start: { x: event.clientX, y: event.clientY }, clickHolds, dragging: false, pickedUp: false };
}

/** Called once by main.ts. Installs the document listeners that aim, drop, and cancel for every target. */
export function installPointerWiring(store: Store): void {

  // The store can drop the held fact on its own: Esc, a drop by keyboard, a
  // model that no longer has the fact. The label and the click mode go with it.
  store.watch(s => s.held?.fact.name, name => {
    if (!name) {
      heldByClick = false;
      if (session?.dragging) endVisuals();
    }
  }, { immediate: false });

  document.addEventListener('pointermove', event => {
    const current = session;
    if (current && event.pointerId === current.pointerId) {
      if (!current.dragging) {
        if (!pastThreshold(current.start, { x: event.clientX, y: event.clientY })) return;
        current.dragging = true;
        if (store.state.held?.fact.name !== current.fact) {
          store.hold(current.fact);
          current.pickedUp = true;
        }
        heldByClick = false;
        startVisuals(store, current.fact);
      }
      if (!store.state.held) return; // Esc during the drag: wait for the release
      event.preventDefault();
      moveLabel(event.clientX, event.clientY);
      const target = hitTest(event.clientX, event.clientY);
      setOverZone(target.zone);
      store.aim(target.rule);
      return;
    }
    // Click then click: hovering a rule aims at it.
    if (!session && heldByClick && store.state.held) {
      const target = targetsOf(event.target);
      store.aim(target.rule);
    }
  }, { passive: false });

  document.addEventListener('pointerup', event => {
    const current = session;
    if (!current || event.pointerId !== current.pointerId) return;
    session = undefined;
    if (current.dragging) {
      swallowClick = true;
      const target = hitTest(event.clientX, event.clientY);
      endVisuals();
      if (!store.state.held) return;
      void release(store, target, event.clientX, event.clientY);
      return;
    }
    const outcome = clickOutcome({ fact: current.fact, clickHolds: current.clickHolds, heldFact: store.state.held?.fact.name, heldByClick });
    if (outcome === 'none') return;
    // The click that follows belongs to this press, not to a drop target
    // around the source (a produces row sits inside its rule's node).
    swallowClick = true;
    if (outcome === 'put-down') store.cancel();
    else {
      store.hold(current.fact);
      heldByClick = !!store.state.held;
    }
  });

  // A click always follows its pointerup before the next press, so a click
  // that never came (a touch the browser turned into a scroll) is forgotten here.
  document.addEventListener('pointerdown', () => { swallowClick = false; }, true);

  const abandon = (event: Event) => {
    const current = session;
    if (!current || (event instanceof PointerEvent && event.pointerId !== current.pointerId)) return;
    session = undefined;
    if (current.dragging) endVisuals();
    if (current.pickedUp && store.state.held?.fact.name === current.fact) store.cancel();
  };
  document.addEventListener('pointercancel', abandon);
  window.addEventListener('blur', abandon);

  // Text selection and native drag and drop must not start during a press on a source.
  document.addEventListener('selectstart', event => { if (session) event.preventDefault(); });
  document.addEventListener('dragstart', event => { if (session) event.preventDefault(); });

  // Capture phase on window, so a drop target's own click handler (a node
  // selecting its rule) never sees the click that dropped on it.
  window.addEventListener('click', event => {
    if (swallowClick) {
      swallowClick = false;
      if (event.detail !== 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
    const held = store.state.held;
    if (!held || event.defaultPrevented) return;
    const target = targetsOf(event.target);
    if (!target.rule && !target.zone) return; // outside any target: stays held
    event.preventDefault();
    event.stopImmediatePropagation();
    void release(store, target, event.clientX, event.clientY);
  }, true);
}

type Target = { rule?: string; zone?: Element };

function targetsOf(element: EventTarget | null): Target {
  if (!(element instanceof Element)) return {};
  const rule = element.closest('[data-drop-rule]')?.getAttribute('data-drop-rule') ?? undefined;
  if (rule) return { rule };
  return { zone: element.closest('[data-drop-zone]') ?? undefined };
}

// The element under the pointer, not the event target: a touch pointer stays
// captured by the source it started on.
function hitTest(x: number, y: number): Target {
  return targetsOf(document.elementFromPoint(x, y));
}

async function release(store: Store, target: Target, clientX: number, clientY: number) {
  heldByClick = false;
  if (target.rule) {
    store.aim(target.rule);
    await store.drop();
    return;
  }
  const fact = store.state.held?.fact.name;
  store.cancel();
  if (!target.zone || !fact) return;
  const detail: ZoneDrop = { fact, zone: target.zone.getAttribute('data-drop-zone') ?? '', clientX, clientY };
  target.zone.dispatchEvent(new CustomEvent<ZoneDrop>('infergo:drop', { bubbles: true, detail }));
}

function startVisuals(store: Store, fact: string) {
  const root = document.documentElement;
  savedStyles = { userSelect: root.style.userSelect, webkitUserSelect: root.style.getPropertyValue('-webkit-user-select'), cursor: root.style.cursor, touchAction: root.style.touchAction };
  root.style.userSelect = 'none';
  root.style.setProperty('-webkit-user-select', 'none');
  root.style.cursor = 'grabbing';
  root.style.touchAction = 'none';
  document.getSelection()?.removeAllRanges();
  const type = store.state.graph.facts.get(fact)?.type ?? '';
  label = document.createElement('div');
  label.className = 'drag-label';
  label.setAttribute('aria-hidden', 'true');
  label.textContent = type ? `${fact} ${type}` : fact;
  // Inline styles: the label lives on <body>, outside every region's root.
  Object.assign(label.style, {
    position: 'fixed', left: '0', top: '0', zIndex: '1000', pointerEvents: 'none',
    background: 'var(--bg, #000)', color: 'var(--teal, #74dfd0)', border: '1px solid var(--teal, #74dfd0)',
    font: '12px/1 var(--mono, monospace)', padding: '7px 10px', whiteSpace: 'nowrap',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.append(label);
}

function moveLabel(x: number, y: number) {
  if (label) label.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 16)}px)`;
}

function setOverZone(zone: Element | undefined) {
  if (zone === overZone) return;
  overZone?.removeAttribute('data-drop-over');
  overZone = zone;
  overZone?.setAttribute('data-drop-over', '');
}

function endVisuals() {
  label?.remove();
  label = undefined;
  setOverZone(undefined);
  if (savedStyles) {
    const root = document.documentElement;
    root.style.userSelect = savedStyles.userSelect;
    root.style.setProperty('-webkit-user-select', savedStyles.webkitUserSelect);
    root.style.cursor = savedStyles.cursor;
    root.style.touchAction = savedStyles.touchAction;
    savedStyles = undefined;
  }
}
