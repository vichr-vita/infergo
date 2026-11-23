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
import type { Store } from './store';

/** Detail of the 'infergo:drop' event dispatched on a data-drop-zone element. */
export type ZoneDrop = { fact: string; zone: string; clientX: number; clientY: number };

/** Call from a source's pointerdown handler to pick the fact up by click or drag. */
export function beginDrag(event: PointerEvent, fact: string, store: Store): void {
  void event;
  store.hold(fact);
}

/** Called once by main.ts. Installs the document listeners that aim, drop, and cancel for every target. */
export function installPointerWiring(store: Store): void {
  void store;
}
