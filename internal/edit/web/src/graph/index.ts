// The graph canvas: every rule as a node and every wire as a dashed, labelled
// arrow, laid out by dagre top to bottom as in the viewer. It turns pointer
// and keyboard input into store actions (pick up, aim, drop, select, apply)
// and draws State: held targets, the pending read and wire, a refused cycle,
// diagnostics with their fixes, the lit fact, and Find. main.ts mounts it once.
//
// Structure, built once in mount and updated in place on every change:
//   heading       title and the toolbar (New rule, zoom, Fit map, Actual size, List)
//   viewport      data-drop-zone="canvas"; pans and zooms through View
//     svg > g.view   wires, wire labels, nodes, the pending layer, the New rule placeholder
//     .graph-scene   HTML fix links, scaled with the graph so they stay crisp
//     .graph-ui      unscaled inline forms (New rule, rename, delete)
//
// Semantic zoom: below compactZoom (where row text would fall under 9 px) the
// viewport carries .compact. Each node then shows only its name, and its
// problem count when there is room, in a group scaled by 1/k so the text stays
// 10 px on screen. The aimed node's state goes above it at the same size.
// Strokes stop scaling, fix links hide, and only the wire labels of the
// selected rule and the lit or held fact stay, also at screen size.
import { verdictMessage, wireKey, type Verdict, type Wire } from '../derive';
import { h, setText } from '../dom';
import { beginDrag, beginDragOnly, dragPoint, reaim, type ZoneDrop } from '../drag';
import type { Fact, Op, Rule, Snapshot } from '../protocol';
import type { Region, Shell } from '../region';
import { matchesQuery, pendingRead, validTargets, type State, type Store } from '../store';
import { Forms, type Draft } from './forms';
import { neighbour, stepTarget, wiresAt, type Direction } from './keys';
import {
  anchorShift, box, buildLabel, buildLayoutInput, buildNode, compactLines, gatherFindings, noFindings, place, shifted,
  type Findings, type Font, type LabelBox, type LayoutInput, type Measure, type NodeBox, type Placement, type PlacedFix, type Rect,
} from './layout';
import { moveTo, Parts, round, setAttributes, svg } from './paint';
import { fitZoom, isCompact, openingView, View, type Transform } from './view';

export const mount: Region = (root, store, shell) => {
  new Canvas(root, store, shell);
};

/** The element with roving focus: a rule's node or a wire's label. */
type Current = { kind: 'rule'; id: string } | { kind: 'wire'; key: string };

const directions: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/** Compact text, in screen pixels: 10 px semibold mono on 11 px lines. graph.css draws .compact-text at this size. */
const compactText = { size: 10, line: 11, padX: 4, padY: 2, mark: 3 };

/** What a compact node shows besides its name: its problem count, or the placeholder's pending read. */
type CompactState = { node: NodeBox; status?: { text: string; tone: 'pending' | 'refused' | 'error' | 'warning' }; mark?: 'error' | 'warning' };

/** Canvas text measurement with the fonts graph.css draws in. */
function canvasMeasure(): Measure {
  const context = document.createElement('canvas').getContext('2d');
  const style = getComputedStyle(document.documentElement);
  const mono = style.getPropertyValue('--mono').trim() || 'monospace';
  const sans = style.getPropertyValue('--sans').trim() || 'sans-serif';
  const fonts: Record<Font, string> = {
    name: `600 14px ${mono}`, port: `12px ${mono}`, type: `11px ${mono}`, label: `12px ${mono}`,
    prose: `13px ${sans}`, value: `16px ${sans}`, note: `12px ${sans}`,
  };
  const cache = new Map<string, number>();
  return (text, font) => {
    const key = `${font}\u0000${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      if (context) { context.font = fonts[font]; width = context.measureText(text).width; }
      else width = Array.from(text).length * 8;
      cache.set(key, width);
    }
    return width;
  };
}

/** The snapshot whose values the nodes show: the selected scenario, else the first case. */
function shownSnapshot(state: State): Snapshot | undefined {
  const cases = state.values?.cases ?? [];
  return state.scenario ? cases.find(snapshot => snapshot.id === state.scenario) : cases[0];
}

function focusFirstIn(region: Element | null) {
  const target = region?.querySelector<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])');
  target?.focus();
}

class Canvas {
  #root: HTMLElement;
  #store: Store;
  #shell: Shell;
  #measure = canvasMeasure();

  #title = h('span', { class: 'graph-title' });
  #fitButton = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Fit map');
  #actualButton = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Actual size');
  #viewport = h('div', { class: 'graph-viewport', 'data-drop-zone': 'canvas' });
  #svg = svg('svg', { class: 'graph-svg', role: 'group', 'aria-label': 'Rule graph', 'aria-describedby': 'graph-help' });
  #viewGroup = svg('g', { class: 'graph-view' });
  #wireLayer = svg('g', { class: 'graph-wires' });
  #labelLayer = svg('g', { class: 'graph-labels' });
  #pendingLayer = svg('g', { class: 'graph-pending', 'aria-hidden': 'true' });
  #ghostLayer = svg('g', { class: 'graph-ghost', 'aria-hidden': 'true' });
  #nodeLayer = svg('g', { class: 'graph-nodes' });
  #scene = h('div', { class: 'graph-scene' });
  #ui = h('div', { class: 'graph-ui' });
  #message = h('p', { class: 'graph-message', hidden: true });

  #wires = new Parts(this.#wireLayer);
  #labels = new Parts(this.#labelLayer);
  #nodes = new Parts(this.#nodeLayer);
  #nodeFixes = new Parts<HTMLDivElement>(this.#scene, () => h('div', { class: 'graph-fixes' }));
  #inner = new WeakMap<Element, Parts>();
  #compactGroups = new WeakMap<Element, SVGGElement>();
  #compactStates = new Map<Element, CompactState>();
  /** Wire label widths by key, for scaling kept labels in compact mode. */
  #labelWidths = new Map<string, number>();
  #fixOps = new WeakMap<HTMLButtonElement, Op>();

  #view: View;
  #forms: Forms;
  #input?: LayoutInput;
  #placement?: Placement;
  #signature = '';
  #viewReady = false;
  #current?: Current;
  #hovered?: string;
  /** True from a press in the graph until the next key, so focus moved by a press never pans the view. */
  #pointerInput = false;
  #litByUs?: string;
  /** A rule to focus once a model that has it is drawn, after New rule or a rename. */
  #focusWhenDrawn?: string;
  /** True while nodes draw in their compact form. */
  #compact = false;
  #rendering = false;
  /** The selected rule the view last brought into sight; a new selection is revealed once it is drawn. */
  #revealed?: string;
  /** The New rule placeholder: its top-left corner in graph units, the dropped read, and the form's fields. */
  #ghost?: { at: Point; read?: Fact; draft: Draft };
  #ghostNode?: SVGGElement;
  /** The aimed node's state above it in compact mode, and the node's top-left corner in graph units. */
  #aimLabel?: { element: SVGGElement; x: number; y: number };

  constructor(root: HTMLElement, store: Store, shell: Shell) {
    this.#root = root;
    this.#store = store;
    this.#shell = shell;
    this.#build();
    this.#view = new View(this.#viewport, transform => this.#applyTransform(transform), (fitted, actual) => {
      this.#fitButton.setAttribute('aria-pressed', String(fitted));
      this.#actualButton.setAttribute('aria-pressed', String(actual));
    });
    this.#forms = new Forms(this.#ui, store, () => this.#focusCurrent());
    this.#listen();
    store.watch(s => [s.graph, s.check, s.values, s.scenario, s.selection, s.highlight, s.held, s.preview, s.query, s.layout], () => this.#render());
    new ResizeObserver(() => this.#ensureView()).observe(this.#viewport);
  }

  // ---- Structure ----------------------------------------------------------

  #build() {
    const newRule = h('button', { type: 'button', 'aria-keyshortcuts': 'N' }, 'New rule');
    const zoomIn = h('button', { type: 'button', class: 'graph-zoom', 'aria-label': 'Zoom in' }, '+');
    const zoomOut = h('button', { type: 'button', class: 'graph-zoom', 'aria-label': 'Zoom out' }, '−');
    const list = h('button', { type: 'button' }, 'List');
    newRule.addEventListener('click', () => this.#openNewRule());
    zoomIn.addEventListener('click', () => this.#view.zoomBy(1.2));
    zoomOut.addEventListener('click', () => this.#view.zoomBy(1 / 1.2));
    this.#fitButton.addEventListener('click', () => this.#view.fit());
    this.#actualButton.addEventListener('click', () => this.#view.actual(this.#rectOf(this.#store.state.selection.rule)));
    list.addEventListener('click', () => this.#store.setListView(true));

    const defs = svg('defs');
    for (const [id, colour] of [['plain', 'var(--edge)'], ['teal', 'var(--teal)'], ['amber', 'var(--amber)'], ['red', 'var(--red)']] as const) {
      const marker = svg('marker', { id: `graph-arrow-${id}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
      marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', style: `fill: ${colour}` }));
      defs.append(marker);
    }
    this.#viewGroup.append(this.#wireLayer, this.#labelLayer, this.#nodeLayer, this.#pendingLayer, this.#ghostLayer);
    this.#svg.append(defs, this.#viewGroup);
    this.#viewport.append(this.#svg, this.#scene, this.#ui, this.#message);
    this.#root.append(
      h('div', { class: 'graph-heading' }, this.#title, h('div', { class: 'graph-tools' }, newRule, zoomIn, zoomOut, this.#fitButton, this.#actualButton, list)),
      this.#viewport,
      h('p', { class: 'graph-hint' }, h('span', {}, 'Drag a fact onto a rule to wire it'), h('span', {}, 'Drop on empty space for a new rule'), h('span', {}, '? shows keys')),
      h('p', { id: 'graph-help', class: 'sr-only' },
        'Arrow keys move between rules along wires: Up to a producer, Down to a reader, Left and Right within a row. Shift with Up or Down moves onto a wire. '
        + 'Enter opens the rule, W picks up a fact it produces, A adds a read, N creates a rule, F2 renames, Delete removes.'),
    );
  }

  #applyTransform({ x, y, k }: Transform) {
    this.#viewGroup.setAttribute('transform', `translate(${round(x)} ${round(y)}) scale(${round(k * 1000) / 1000})`);
    this.#scene.style.transform = `translate(${round(x)}px, ${round(y)}px) scale(${k})`;
    const compact = isCompact(k);
    const flipped = compact !== this.#compact;
    this.#compact = compact;
    this.#viewport.classList.toggle('compact', compact);
    if (this.#rendering) return;
    // Crossing the threshold changes what is drawn; zooming within compact only rescales its text.
    if (flipped) this.#render();
    else if (compact) this.#scaleCompact();
  }

  #rectOf(rule: string | undefined): Rect | undefined {
    return rule ? this.#placement?.nodes.get(rule) : undefined;
  }

  /** Client point of a graph point, for forms placed over the canvas. */
  #toCanvas(x: number, y: number) {
    const { x: tx, y: ty, k } = this.#view.transform;
    return { x: x * k + tx, y: y * k + ty };
  }

  // The first view, once the canvas has a size: the selected rule centred with
  // its producers and readers, at the largest zoom where they fit, between the
  // compact threshold and Actual size. The whole map when it fits at least as large.
  #ensureView() {
    if (this.#viewReady || !this.#placement || !this.#viewport.clientWidth || !this.#viewport.clientHeight) return;
    this.#viewReady = true;
    const placement = this.#placement;
    this.#view.setBounds(placement.bounds);
    const state = this.#store.state;
    const selected = state.selection.rule;
    const focus = this.#rectOf(selected);
    this.#revealed = selected;
    if (!focus) { this.#view.fit(); return; }
    const neighbours = state.graph.wires.flatMap(wire => wire.to === selected ? [wire.from] : wire.from === selected ? [wire.to] : []);
    const around = neighbours.flatMap(id => placement.nodes.get(id) ?? []);
    const opening = openingView(focus, around, this.#view.size);
    if (fitZoom(placement.bounds, this.#view.size.width, this.#view.size.height) >= opening.k) this.#view.fit();
    else this.#view.set(opening);
  }

  // A rule selected anywhere (the sheet's producer links, the Facts column,
  // History, a drop) is brought into view once, by the smallest pan. A rule
  // that is not drawn yet, such as one just created, is revealed when it is.
  #revealSelection(state: State) {
    const selected = state.selection.rule;
    if (!this.#viewReady || selected === this.#revealed) return;
    const rect = this.#rectOf(selected);
    if (selected && !rect) return;
    this.#revealed = selected;
    if (rect) this.#view.reveal(rect);
  }

  // ---- Render -------------------------------------------------------------

  #render() {
    this.#rendering = true;
    try { this.#renderNow(); } finally { this.#rendering = false; }
  }

  #renderNow() {
    const state = this.#store.state;
    setText(this.#title, `${state.model.package} · rule dependencies`);
    const snapshot = shownSnapshot(state);
    const findings = gatherFindings(state.graph, state.check?.diagnostics ?? [], state.check?.pruned ?? []);
    const input = buildLayoutInput(state.graph, findings, this.#measure, snapshot);
    this.#input = input;
    if (input.signature !== this.#signature) {
      let next: Placement;
      try {
        next = place(input);
      } catch (error) {
        console.error('Rule graph layout failed', error);
        this.#showMessage('The graph could not be drawn. The List view shows every rule.');
        return;
      }
      const { dx, dy } = anchorShift(this.#placement, next, [state.selection.rule, this.#hovered]);
      this.#placement = shifted(next, dx, dy);
      this.#signature = input.signature;
      this.#view.setBounds(this.#placement.bounds);
    }
    this.#showMessage(state.graph.rules.size ? '' : 'No rules yet. New rule, or drop a fact here, creates one.');
    const focusedInside = this.#root.contains(document.activeElement) && !this.#ui.contains(document.activeElement);
    this.#settleCurrent(state);
    // The view first, so the draw knows whether nodes are compact.
    this.#ensureView();
    this.#draw(state, findings, snapshot);
    this.#revealSelection(state);
    if (this.#focusWhenDrawn && this.#placement?.nodes.has(this.#focusWhenDrawn)) {
      this.#current = { kind: 'rule', id: this.#focusWhenDrawn };
      this.#focusWhenDrawn = undefined;
      this.#syncTabStops();
      this.#focusCurrent();
    } else if (focusedInside && !this.#root.contains(document.activeElement)) {
      // The focused element went away (a removed wire): focus moves to what replaced it.
      this.#focusCurrent();
    }
  }

  #showMessage(text: string) {
    this.#message.hidden = !text;
    setText(this.#message, text);
  }

  // The roving focus must name something that still exists.
  #settleCurrent(state: State) {
    const current = this.#current;
    if (current?.kind === 'rule' && state.graph.rules.has(current.id)) return;
    if (current?.kind === 'wire') {
      if (state.graph.wires.some(wire => wireKey(wire) === current.key)) return;
      const reader = current.key.split('>')[2];
      if (reader && state.graph.rules.has(reader)) { this.#current = { kind: 'rule', id: reader }; return; }
    }
    const fallback = state.selection.rule ?? state.graph.rules.keys().next().value;
    this.#current = fallback ? { kind: 'rule', id: fallback } : undefined;
  }

  #draw(state: State, findings: Findings, snapshot: Snapshot | undefined) {
    const placement = this.#placement;
    const input = this.#input;
    if (!placement || !input) return;
    const { held, selection, highlight } = state;
    const heldVerdictWires = held?.verdict && !held.verdict.ok && held.verdict.reason === 'cycle' ? new Set(held.verdict.wires.map(wireKey)) : new Set<string>();
    const heldProducers = new Set(held ? state.graph.facts.get(held.fact.name)?.producers ?? [] : []);
    const ruleMatches = (id: string) => {
      const rule = state.graph.rules.get(id);
      return !rule || matchesQuery(state, rule.id, ...rule.reads.map(fact => fact.name), ...rule.produces.map(fact => fact.name));
    };
    const boxes = new Map(input.nodes.map(node => [node.id, node]));

    // Nodes, with the aimed node's extra rows.
    const drawn = new Map<string, NodeBox>();
    this.#nodes.begin();
    this.#nodeFixes.begin();
    for (const rule of state.graph.rules.values()) {
      const rect = placement.nodes.get(rule.id);
      const base = boxes.get(rule.id);
      if (!rect || !base) continue;
      const pending = pendingRead(state, rule.id);
      // The rule a fact is dragged out of is under the pointer as the drag
      // starts; its own product is no refusal worth drawing there.
      const origin = held?.over === rule.id && held.verdict && !held.verdict.ok && held.verdict.reason === 'produces';
      const aimed = held?.over === rule.id && !origin ? held.verdict : undefined;
      const refusal = aimed && !aimed.ok ? refusalNote(aimed, held!.fact.name, rule.id, state) : undefined;
      const node = pending || refusal ? buildNode(rule, state.graph, findings, this.#measure, snapshot, { pending, refusal }) : base;
      drawn.set(rule.id, node);
      const verdict = held?.verdicts.get(rule.id);
      const onCycle = !!held?.verdict && !held.verdict.ok && held.verdict.reason === 'cycle' && held.verdict.path.includes(rule.id);
      const isSource = heldProducers.has(rule.id);
      const counts = findings.counts.get(rule.id);
      const classes = ['graph-node',
        selection.rule === rule.id && 'selected',
        held && verdict?.ok && held.over !== rule.id && 'valid',
        aimed && (aimed.ok ? 'target' : 'refused'),
        held && verdict && !verdict.ok && !isSource && !onCycle && !aimed && 'dim',
        !held && !ruleMatches(rule.id) && 'dim',
        onCycle && held?.over !== rule.id && 'on-cycle',
        findings.pruned.has(rule.id) && 'pruned',
        counts?.errors && 'error',
      ].filter(Boolean).join(' ');
      const element = this.#nodes.part(rule.id, '', g => this.#buildNodeElement(g));
      setAttributes(element, {
        class: classes, 'data-rule': rule.id, 'data-drop-rule': rule.id, role: 'group', 'aria-roledescription': 'rule',
        'aria-label': node.label, 'aria-current': selection.rule === rule.id ? 'true' : undefined,
        'aria-keyshortcuts': 'Enter W A F2 Delete N',
      });
      moveTo(element, rect.x, rect.y);
      this.#drawNode(element, node, state);
      this.#drawNodeFixes(rule.id, rect, node, classes.includes(' dim'));
      const problems = node.problems;
      this.#compactStates.set(element, { node, status: problems && { text: problems.text, tone: problems.tone }, mark: problems?.tone });
    }
    this.#nodes.end();
    for (const element of this.#compactStates.keys()) if (!element.isConnected) this.#compactStates.delete(element);

    // Wires and their labels.
    this.#wires.begin();
    this.#labels.begin();
    for (const wire of state.graph.wires) {
      const key = wireKey(wire);
      const points = placement.wires.get(key);
      const rect = placement.labels.get(key);
      const label = input.labels.find(candidate => candidate.key === key) ?? buildLabel(wire, state.graph, findings, this.#measure);
      if (!points || !rect) continue;
      const tone = heldVerdictWires.has(key) ? 'cycle'
        : findings.cycleWires.has(key) || findings.mismatch.has(`${wire.to}>${wire.fact}`) ? 'error'
          : selection.wire && wireKey(selection.wire) === key ? 'selected'
            : highlight === wire.fact ? 'lit'
              : selection.rule === wire.from || selection.rule === wire.to ? 'near' : '';
      const dim = (!held && state.query && !ruleMatches(wire.from) && !ruleMatches(wire.to)) || (held && heldVerdictWires.size && !heldVerdictWires.has(key));
      const classes = ['graph-wire', tone, selection.wire && wireKey(selection.wire) === key && 'chosen', highlight === wire.fact && 'lit', dim && 'dim'].filter(Boolean).join(' ');
      const marker = tone === 'cycle' ? 'amber' : tone === 'error' ? 'red' : tone ? 'teal' : 'plain';
      const d = points.map((point, index) => `${index ? 'L' : 'M'}${round(point.x)},${round(point.y)}`).join(' ');
      const group = this.#wires.part(key, d, g => {
        g.replaceChildren(svg('path', { class: 'hit', d }), svg('path', { class: 'line', d }));
      });
      setAttributes(group, { class: classes, 'data-wire': key, 'data-fact': wire.fact });
      setAttributes(group.lastElementChild!, { 'marker-end': `url(#graph-arrow-${marker})` });
      const keep = selection.rule === wire.from || selection.rule === wire.to || highlight === wire.fact || held?.fact.name === wire.fact
        || (!!selection.wire && wireKey(selection.wire) === key);
      this.#drawLabel(label, rect, keep ? `${classes} keep` : classes, wire);
    }
    this.#wires.end();
    this.#labels.end();
    for (const key of this.#labelWidths.keys()) if (!this.#labels.get(key)) this.#labelWidths.delete(key);
    this.#nodeFixes.end();

    this.#drawPending(state, drawn);
    this.#drawGhost(state);
    this.#scaleCompact();
    this.#syncTabStops();
  }

  #buildNodeElement(g: SVGGElement) {
    const compact = svg('g', { class: 'compact-name' });
    g.append(svg('rect', { class: 'box' }), svg('rect', { class: 'ring' }), compact);
    this.#inner.set(g, new Parts(g));
    this.#compactGroups.set(g, compact);
  }

  // Width of compact text in screen pixels: the name font measured at 14 px, scaled to 10.
  #compactMeasure = (text: string) => this.#measure(text, 'name') * compactText.size / 14;

  /**
   * Redraws every compact node's text and every kept wire label for the
   * current zoom. Kept labels grow to screen size, so one that would cover
   * another kept label is hidden (.crowded), the chosen wire's first.
   */
  #scaleCompact() {
    const k = this.#view.transform.k;
    for (const [element, compact] of this.#compactStates) this.#drawCompactNode(element, compact, k);
    if (this.#aimLabel) setAttributes(this.#aimLabel.element, { transform: `translate(${round(this.#aimLabel.x)} ${round(this.#aimLabel.y)}) scale(${round(1 / k * 1000) / 1000})` });
    const scale = compactText.size / 12 / k;
    const shown: Rect[] = [];
    const labels = [...this.#labels.entries()].sort(([, a], [, b]) => Number(b.element.classList.contains('chosen')) - Number(a.element.classList.contains('chosen')));
    for (const [key, item] of labels) {
      const inner = item.element.firstElementChild;
      const width = this.#labelWidths.get(key);
      const rect = this.#placement?.labels.get(key);
      if (!inner || width === undefined || !rect) continue;
      let crowded = false;
      if (this.#compact && item.element.classList.contains('keep')) {
        const grown = { x: rect.x + width / 2 * (1 - scale), y: rect.y + 12 * (1 - scale), width: width * scale, height: 24 * scale };
        crowded = shown.some(other => overlaps(grown, other));
        if (!crowded) shown.push(grown);
      }
      item.element.classList.toggle('crowded', crowded);
      setAttributes(inner, { transform: this.#compact ? `translate(${round(width / 2)} 12) scale(${round(scale * 1000) / 1000}) translate(${round(-width / 2)} -12)` : undefined });
    }
  }

  // A compact node's name, in screen pixels inside a group scaled by 1/k: as
  // many lines as the box has room for, broken between the words of the name,
  // then the problem count once the name has two lines. A 3 px rule on the
  // left marks problems: solid for errors, dashed for warnings.
  #drawCompactNode(element: Element, compact: CompactState, k: number) {
    const group = this.#compactGroups.get(element);
    if (!group) return;
    if (!this.#compact) {
      if (group.firstChild) group.replaceChildren();
      return;
    }
    const { node, status, mark } = compact;
    const width = node.width * k, height = node.height * k;
    const { line, padX, padY } = compactText;
    const textWidth = width - 2 * padX - (mark ? compactText.mark : 0);
    // A tenth of a line of slack, so a box a fraction of a pixel short still gets its second line.
    const room = Math.max(1, Math.floor((height - 2 * padY) / line + 0.1));
    const showStatus = !!status && (room > 2 || (room > 1 && status.tone === 'pending'));
    const name = compactLines(`${node.id}()`, textWidth, showStatus ? room - 1 : room, this.#compactMeasure);
    const statusLine = showStatus ? compactLines(status!.text, textWidth, 1, this.#compactMeasure)[0] : undefined;
    const lines = name.length + (statusLine ? 1 : 0);
    const top = Math.max(padY, (height - lines * line) / 2);
    const left = padX + (mark ? compactText.mark : 0);
    const signature = JSON.stringify([name, statusLine, status?.tone, mark, round(height), round(top)]);
    if (group.dataset.signature !== signature) {
      group.dataset.signature = signature;
      const children: SVGElement[] = [svg('title', {}, `${node.id}()`)];
      if (mark) children.push(svg('path', { class: `mark ${mark}`, d: `M${compactText.mark / 2},0 V${round(height)}` }));
      name.forEach((text, index) => children.push(svg('text', { class: 'compact-text', x: left, y: round(top + (index + 1) * line - 3) }, text)));
      if (statusLine) children.push(svg('text', { class: `compact-text ${status!.tone}`, x: left, y: round(top + lines * line - 3) }, statusLine));
      group.replaceChildren(...children);
    }
    setAttributes(group, { transform: `scale(${1 / k})` });
  }

  #drawNode(element: SVGGElement, node: NodeBox, state: State) {
    const parts = this.#inner.get(element)!;
    const [rect, ring] = [element.children[0]!, element.children[1]!];
    setAttributes(rect, { x: 0, y: 0, width: node.width, height: node.height });
    setAttributes(ring, { x: -5, y: -5, width: node.width + 10, height: node.height + 10 });
    const left = box.pad;
    const right = node.width - box.pad;
    const held = state.held?.fact.name;
    parts.begin();
    const row = (row: NodeBox['reads'][number]) => {
      const signature = JSON.stringify([row.lines, row.typeText, row.typeBelow, row.origin, row.pending, row.top, row.value]);
      const g = parts.part(`${row.part}:${row.fact}`, signature, g => {
        const children: SVGElement[] = [svg('rect', { class: 'row-hit', x: 4, y: row.top, width: node.width - 8, height: row.height + (row.value ? 24 : 0) })];
        if (row.pending) children.push(svg('text', { class: 'pin-plus', x: left - 1, y: row.top + 12 }, '+'));
        else children.push(svg('rect', { class: `pin ${row.part === 'read' && row.origin !== 'rule' ? 'hollow' : 'filled'}`, x: left + 0.5, y: row.top + 4.5, width: 6, height: 6 }));
        row.lines.forEach((line, index) => children.push(svg('text', { class: 'port', x: left + box.pin, y: row.top + 12 + index * box.row }, index === 0 && row.pending ? line.replace(/^\+ /, '') : line)));
        children.push(svg('text', { class: 'ptype', x: right, y: row.top + 12 + (row.typeBelow ? row.lines.length * box.row : 0) }, row.typeText));
        if (row.value) children.push(svg('text', { class: `value ${row.value.tone === 'error' ? 'bad' : ''}`, x: left, y: row.value.top + 17 }, row.value.text));
        if (row.origin === 'missing' && row.part === 'read') {
          const y = row.top + 9;
          children.push(svg('path', { class: 'stub', d: `M-40,${y} H0` }), svg('text', { class: 'stub-mark', x: -50, y: y + 4 }, '×'));
        }
        g.replaceChildren(...children);
      });
      const source = !row.pending;
      setAttributes(g, {
        class: ['graph-fact', row.part, row.pending && 'pending', row.error && 'bad', (state.highlight === row.fact || held === row.fact) && 'lit'].filter(Boolean).join(' '),
        'data-fact': row.fact,
        'data-fact-source': source ? row.fact : undefined,
        tabindex: source ? -1 : undefined,
        role: source ? 'button' : undefined,
        'aria-label': row.pending
          ? `Pending read ${row.fact} ${row.type}`
          : `${row.fact} ${row.typeText}, ${row.part === 'read' ? (row.origin === 'input' ? 'read from an input' : row.origin === 'missing' ? 'read, no producer' : 'read') : 'produced'}. W picks it up, F2 renames.`,
      });
    };
    node.reads.forEach(row);
    if (node.readsDivider !== undefined) parts.part('reads-divider', String(node.readsDivider), g => g.replaceChildren(svg('line', { class: 'divider', x1: left, x2: right, y1: node.readsDivider!, y2: node.readsDivider! })));
    parts.part('name', JSON.stringify(node.name), g => g.replaceChildren(...node.name.lines.map((line, index) => svg('text', { class: 'name', x: left, y: node.name.top + 16 + index * box.nameLine }, line))));
    if (node.problems) {
      const problems = node.problems;
      parts.part('problems', JSON.stringify(problems), g => g.replaceChildren(svg('text', {
        class: `problems ${problems.tone}`, x: problems.ownLine ? left : right, y: problems.top + (problems.ownLine ? 12 : 16),
        'text-anchor': problems.ownLine ? 'start' : 'end',
      }, problems.text)));
    }
    parts.part('requirement', JSON.stringify(node.requirement), g => g.replaceChildren(...node.requirement.lines.map((line, index) => svg('text', { class: 'prose', x: left, y: node.requirement.top + 13 + index * box.proseLine }, line))));
    if (node.producesDivider !== undefined) parts.part('produces-divider', String(node.producesDivider), g => g.replaceChildren(svg('line', { class: 'divider', x1: left, x2: right, y1: node.producesDivider!, y2: node.producesDivider! })));
    node.produces.forEach(row);
    if (node.notesDivider !== undefined) parts.part('notes-divider', String(node.notesDivider), g => g.replaceChildren(svg('line', { class: 'divider', x1: left, x2: right, y1: node.notesDivider!, y2: node.notesDivider! })));
    for (const note of node.notes) {
      parts.part(`note:${note.key}`, JSON.stringify([note.lines, note.top, note.tone]), g => g.replaceChildren(
        ...note.lines.map((line, index) => svg('text', { class: `note ${note.tone}`, x: left, y: note.top + 12 + index * box.noteLine }, line))));
    }
    parts.end();
  }

  /** Fix links of one node, as HTML buttons in the scaled scene layer. */
  #drawNodeFixes(rule: string, rect: Rect, node: NodeBox, dim: boolean) {
    const fixes = node.notes.flatMap(note => note.fixes);
    if (!fixes.length) return;
    const layer = this.#nodeFixes.part(`node:${rule}`, JSON.stringify(fixes.map(fix => [fix.fix.label, fix.fix.op, fix.x, fix.y])), div => {
      div.replaceChildren(...fixes.map(fix => this.#fixButton(fix, `${fix.fix.label} (${rule})`)));
    });
    // The links sit over the node, so a fact dropped on them lands on the rule.
    setAttributes(layer, { 'data-rule-fixes': rule, 'data-drop-rule': rule, class: dim ? 'graph-fixes dim' : 'graph-fixes' });
    moveTo(layer, rect.x, rect.y);
  }

  #fixButton(fix: PlacedFix, accessibleName: string): HTMLButtonElement {
    const button = h('button', { type: 'button', class: 'fix graph-fix', 'aria-label': accessibleName, tabindex: -1 }, fix.fix.label);
    button.style.left = `${fix.x}px`;
    button.style.top = `${fix.y}px`;
    button.style.width = `${fix.width + 2}px`;
    this.#fixOps.set(button, fix.fix.op);
    return button;
  }

  #drawLabel(label: LabelBox, rect: Rect, classes: string, wire: Wire) {
    const g = this.#labels.part(label.key, JSON.stringify([label.text, label.width, label.height]), g => {
      const inner = svg('g', { class: 'label-inner' });
      inner.append(
        svg('rect', { class: 'label-box', x: 0, y: 0, width: label.width, height: 24 }),
        svg('text', { class: 'label-text', x: label.width / 2, y: 16 }, label.text),
      );
      g.replaceChildren(inner);
      this.#labelWidths.set(label.key, label.width);
    });
    setAttributes(g, {
      class: classes.replace('graph-wire', 'graph-label'), 'data-wire': label.key, 'data-fact': wire.fact, 'data-fact-source': wire.fact,
      role: 'button', 'aria-label': `Wire ${wire.fact} from ${wire.from} to ${wire.to}. Delete removes the read. Drag picks up ${wire.fact}.`,
      'aria-pressed': classes.includes('chosen') ? 'true' : 'false',
    });
    moveTo(g, rect.x, rect.y);
    if (label.fix) {
      const fix = { ...label.fix, x: (label.width - label.fix.width) / 2 };
      const layer = this.#nodeFixes.part(`wire:${label.key}`, JSON.stringify([fix.fix.op, fix.x, fix.y]), div => {
        div.replaceChildren(this.#fixButton(fix, `Remove ${wire.fact} from ${wire.to}`));
      });
      layer.dataset.wire = label.key;
      moveTo(layer, rect.x, rect.y);
    }
  }

  // The pending wire into the aimed rule, or the path a refused drop would close.
  #drawPending(state: State, drawn: ReadonlyMap<string, NodeBox>) {
    const held = state.held;
    const placement = this.#placement!;
    const children: SVGElement[] = [];
    this.#aimLabel = undefined;
    const over = held?.over;
    const target = over ? placement.nodes.get(over) : undefined;
    const targetBox = over ? drawn.get(over) : undefined;
    if (held && over && target && targetBox && held.verdict) {
      const producer = state.graph.facts.get(held.fact.name)?.producers[0];
      const from = producer ? placement.nodes.get(producer) : undefined;
      if (held.verdict.ok) {
        const row = targetBox.reads.find(candidate => candidate.pending);
        const end = { x: target.x, y: target.y + (row ? row.top + 9 : 20) };
        if (from) {
          const start = { x: from.x + from.width / 2, y: from.y + from.height };
          const c1 = { x: start.x, y: start.y + 70 }, c2 = { x: end.x - 70, y: end.y };
          children.push(svg('path', { class: 'pending-wire', d: `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`, 'marker-end': 'url(#graph-arrow-teal)' }));
          // Optional: the "+" row in the target already names the fact, so the
          // label is left out when it would cover a rule or another label. In
          // compact mode the aim label under the node names it instead.
          if (!this.#compact) children.push(...this.#floatingLabel([start, c1, c2, end], [0.82, 0.18, 0.5, 0.65, 0.35], `+ ${held.fact.name}`, 'pending-label', drawn, false));
        } else {
          children.push(svg('path', { class: 'pending-wire', d: `M${end.x - 56},${end.y} H${end.x}`, 'marker-end': 'url(#graph-arrow-teal)' }));
        }
      } else if (held.verdict.reason === 'cycle' && from) {
        const reach = Math.max(from.x + from.width, target.x + target.width) + 70;
        const start = { x: from.x + from.width, y: from.y + from.height / 2 };
        const end = { x: target.x + target.width, y: target.y + Math.min(targetBox.height / 2, 40) };
        const c1 = { x: reach, y: start.y }, c2 = { x: reach, y: end.y };
        children.push(svg('path', { class: 'closing-wire', d: `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`, 'marker-end': 'url(#graph-arrow-amber)' }));
        if (!this.#compact) children.push(...this.#floatingLabel([start, c1, c2, end], [0.5, 0.35, 0.65, 0.2, 0.8], 'would close the loop', 'closing-label', drawn));
      }
      // Compact: the aimed node has no room for another line, so its state goes
      // above it at screen size, over the pending wires and clear of the drag
      // label, which follows the pointer below and to the right.
      const origin = !held.verdict.ok && held.verdict.reason === 'produces';
      if (this.#compact && !origin) {
        const text = held.verdict.ok ? `+ ${held.fact.name} ${held.fact.type}` : refusalNote(held.verdict, held.fact.name, over, state);
        const label = svg('g', { class: 'aim-label' });
        const width = this.#compactMeasure(text) + 2 * compactText.padX;
        label.append(
          svg('rect', { class: 'aim-box', x: 0, y: -compactText.line - 7, width: round(width), height: compactText.line + 4 }),
          svg('text', { class: `aim-text ${held.verdict.ok ? 'pending' : 'refused'}`, x: compactText.padX, y: -8 }, text),
        );
        this.#aimLabel = { element: label, x: target.x, y: target.y };
        children.push(label);
      }
    }
    this.#pendingLayer.replaceChildren(...children);
  }

  // The New rule placeholder: a dashed teal node where the rule will go, with
  // the dropped fact as its pending read and a pending wire from its producer.
  #drawGhost(state: State) {
    const ghost = this.#ghost;
    if (!ghost) {
      this.#ghostLayer.replaceChildren();
      this.#ghostNode = undefined;
      return;
    }
    const node = this.#ghostBox(state, ghost);
    if (!this.#ghostNode) {
      this.#ghostNode = svg('g');
      this.#buildNodeElement(this.#ghostNode);
    }
    const element = this.#ghostNode;
    setAttributes(element, { class: 'graph-node placeholder' });
    moveTo(element, ghost.at.x, ghost.at.y);
    this.#drawNode(element, node, state);
    this.#compactStates.set(element, { node, status: ghost.read ? { text: `+ ${ghost.read.name}`, tone: 'pending' } : undefined });
    const children: SVGElement[] = [];
    const producer = ghost.read ? state.graph.facts.get(ghost.read.name)?.producers[0] : undefined;
    const from = producer ? this.#placement?.nodes.get(producer) : undefined;
    if (from) {
      const start = { x: from.x + from.width / 2, y: from.y + from.height };
      const end = { x: ghost.at.x + node.width / 2, y: ghost.at.y };
      const bend = Math.max(40, Math.min(120, Math.abs(end.y - start.y) / 2));
      children.push(svg('path', { class: 'pending-wire', d: `M${round(start.x)},${round(start.y)} C${round(start.x)},${round(start.y + bend)} ${round(end.x)},${round(end.y - bend)} ${round(end.x)},${round(end.y)}`, 'marker-end': 'url(#graph-arrow-teal)' }));
    }
    this.#ghostLayer.replaceChildren(...children, element);
  }

  /** The placeholder's contents: the rule the form would create, drawn like any node. */
  #ghostBox(state: State, ghost: { read?: Fact; draft: Draft }): NodeBox {
    const { name, result, type } = ghost.draft;
    const rule: Rule = {
      id: name || 'Unnamed', file: '', line: 0, source: '', sourceHash: '', usesContext: false, returnsError: true, stub: true,
      requirement: name ? `${name} TODO: state the requirement.` : 'Name the rule in the form.',
      reads: [], produces: result ? [{ name: result, type: type || '?' }] : [],
    };
    return buildNode(rule, state.graph, noFindings, this.#measure, undefined, { pending: ghost.read });
  }

  // A label on a pending curve, at the first of `ts` where it covers no rule
  // and no wire label. With no clear spot it goes at the first, or nowhere
  // when `required` is false.
  #floatingLabel(curve: [Point, Point, Point, Point], ts: number[], text: string, className: string, drawn: ReadonlyMap<string, NodeBox>, required = true): SVGElement[] {
    const width = this.#measure(text, className === 'closing-label' ? 'note' : 'label') + 16;
    const placement = this.#placement!;
    const obstacles: Rect[] = [...placement.labels.values()];
    for (const [id, rect] of placement.nodes) obstacles.push({ ...rect, height: drawn.get(id)?.height ?? rect.height });
    const clear = (at: Point) => obstacles.every(rect => at.x + width / 2 + 4 < rect.x || at.x - width / 2 - 4 > rect.x + rect.width || at.y + 16 < rect.y || at.y - 16 > rect.y + rect.height);
    const points = ts.map(t => cubicAt(...curve, t));
    const at = points.find(clear) ?? (required ? points[0] : undefined);
    if (!at) return [];
    return [
      svg('rect', { class: `${className}-box`, x: at.x - width / 2, y: at.y - 12, width, height: 24 }),
      svg('text', { class: className, x: at.x, y: at.y + 4 }, text),
    ];
  }

  /** One tab stop: the current node or wire label. Fix links of the current node are reachable after it. */
  #syncTabStops() {
    const current = this.#current;
    const currentKey = current?.kind === 'rule' ? current.id : current?.key;
    for (const [key, item] of this.#nodes.entries()) setAttributes(item.element, { tabindex: current?.kind === 'rule' && key === currentKey ? 0 : -1 });
    for (const [key, item] of this.#labels.entries()) setAttributes(item.element, { tabindex: current?.kind === 'wire' && key === currentKey ? 0 : -1 });
    for (const [key, item] of this.#nodeFixes.entries()) {
      const owner = key.slice(key.indexOf(':') + 1);
      const reachable = owner === currentKey;
      for (const button of item.element.querySelectorAll('button')) button.tabIndex = reachable ? 0 : -1;
    }
    setAttributes(this.#viewport, { tabindex: current ? undefined : 0 });
  }

  #currentElement(): SVGGElement | undefined {
    const current = this.#current;
    if (!current) return undefined;
    return current.kind === 'rule' ? this.#nodes.get(current.id) : this.#labels.get(current.key);
  }

  #focusCurrent() {
    const element = this.#currentElement();
    if (!element) { this.#viewport.focus({ preventScroll: true }); return; }
    element.focus({ preventScroll: true });
    this.#revealCurrent();
  }

  #revealCurrent() {
    const current = this.#current;
    if (!current || !this.#placement) return;
    const rect = current.kind === 'rule' ? this.#placement.nodes.get(current.id) : this.#placement.labels.get(current.key);
    if (rect) this.#view.reveal(rect);
  }

  #moveTo(current: Current) {
    this.#current = current;
    this.#syncTabStops();
    this.#focusCurrent();
  }

  // ---- Input --------------------------------------------------------------

  #listen() {
    const store = this.#store;
    const svgRoot = this.#svg;

    svgRoot.addEventListener('pointerdown', event => {
      const target = event.target instanceof Element ? event.target : undefined;
      const label = target?.closest<SVGGElement>('.graph-label');
      if (label?.dataset.fact) { beginDragOnly(event, label.dataset.fact, store); return; }
      const row = target?.closest<SVGGElement>('[data-fact-source]');
      if (row?.dataset.fact) beginDrag(event, row.dataset.fact, store);
    });

    // Clicks: a node selects its rule, a wire or its label selects the wire,
    // empty canvas clears the wire selection. Clicks that dropped a held fact
    // never get here (drag.ts takes them first).
    this.#viewport.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : undefined;
      if (!target || target.closest('.graph-ui, .graph-scene button')) return;
      const wireElement = target.closest<SVGGElement>('[data-wire]');
      if (wireElement?.dataset.wire) {
        const wire = store.state.graph.wires.find(candidate => wireKey(candidate) === wireElement.dataset.wire);
        if (wire) {
          store.select({ wire });
          this.#moveTo({ kind: 'wire', key: wireKey(wire) });
        }
        return;
      }
      const row = target.closest<SVGGElement>('[data-fact-source]');
      const node = target.closest<SVGGElement>('[data-rule]');
      if (node?.dataset.rule) {
        store.select({ rule: node.dataset.rule, wire: undefined });
        this.#current = { kind: 'rule', id: node.dataset.rule };
        this.#syncTabStops();
        // A clicked fact row keeps focus, so F2 renames that fact.
        if (row) row.focus({ preventScroll: true });
        else node.focus({ preventScroll: true });
        return;
      }
      if (store.state.selection.wire) store.select({ wire: undefined });
    });

    // One fact lit everywhere: hover or focus a fact row or a wire.
    const light = (target: EventTarget | null) => {
      const fact = target instanceof Element ? target.closest<SVGGElement>('[data-fact]')?.dataset.fact : undefined;
      if (fact) { this.#litByUs = fact; store.highlight(fact); }
      else if (this.#litByUs && store.state.highlight === this.#litByUs) { this.#litByUs = undefined; store.highlight(undefined); }
    };
    svgRoot.addEventListener('pointerover', event => {
      light(event.target);
      const node = event.target instanceof Element ? event.target.closest<SVGGElement>('[data-rule]') : null;
      this.#hovered = node?.dataset.rule;
    });
    svgRoot.addEventListener('pointerleave', () => { light(null); this.#hovered = undefined; });
    svgRoot.addEventListener('focusin', event => light(event.target));
    svgRoot.addEventListener('focusout', event => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-fact]'))) light(null); });
    svgRoot.addEventListener('focusin', event => {
      // Chromium focuses the <svg> itself on a click on empty canvas. Hand focus
      // to the current rule, so the keys keep working after a click.
      if (event.target === svgRoot) { this.#currentElement()?.focus({ preventScroll: true }); return; }
      const target = event.target instanceof Element ? event.target : undefined;
      const node = target?.closest<SVGGElement>('[data-rule]');
      const label = target?.closest<SVGGElement>('.graph-label');
      if (label?.dataset.wire) this.#current = { kind: 'wire', key: label.dataset.wire };
      else if (node?.dataset.rule) this.#current = { kind: 'rule', id: node.dataset.rule };
      this.#syncTabStops();
      // Tab into the graph reveals the focused rule. Focus that follows a
      // press does not pan: the user is already looking where they pressed.
      if ((target === node || target === label) && !this.#pointerInput) this.#revealCurrent();
    });
    this.#root.addEventListener('pointerdown', () => { this.#pointerInput = true; }, true);
    document.addEventListener('keydown', () => { this.#pointerInput = false; }, true);

    // Fix links preview on hover and focus and apply on click.
    const fixOp = (target: EventTarget | null) => target instanceof HTMLButtonElement ? this.#fixOps.get(target) : undefined;
    this.#scene.addEventListener('pointerover', event => { const op = fixOp(event.target); if (op) store.previewOp(op); });
    this.#scene.addEventListener('pointerout', event => { const op = fixOp(event.target); if (op && !(event.target as HTMLElement).matches(':focus')) store.clearPreview(op); });
    this.#scene.addEventListener('focusin', event => { const op = fixOp(event.target); if (op) store.previewOp(op); });
    this.#scene.addEventListener('focusout', event => { const op = fixOp(event.target); if (op) store.clearPreview(op); });
    this.#scene.addEventListener('click', event => {
      const op = fixOp(event.target);
      if (!op) return;
      event.stopPropagation();
      store.clearPreview(op);
      void store.apply(op);
    });

    // A fact dropped on empty canvas becomes the read of a new rule.
    this.#viewport.addEventListener('infergo:drop', event => {
      const detail = (event as CustomEvent<ZoneDrop>).detail;
      const info = store.state.graph.facts.get(detail.fact);
      this.#openNewRule(this.#view.toGraph({ x: detail.clientX, y: detail.clientY }), info ? { name: info.name, type: info.type } : undefined);
    });

    // A drag that rests near an edge of the canvas pans towards it, and aims at
    // whatever passes under the pointer. Window, so drag.ts has seen the move first.
    window.addEventListener('pointermove', event => {
      if (dragPoint()) this.#view.edgePan(dragPoint, reaim, { x: event.clientX, y: event.clientY }, () => !!store.state.held?.verdict?.ok);
    });

    this.#root.addEventListener('keydown', event => this.#onKey(event));
  }

  // The New rule form, with the placeholder node at `at` (graph units): where
  // a fact was dropped, under the rule N was pressed on, or mid-canvas. The
  // form goes beside the placeholder, else below it, so both stay visible.
  #openNewRule(at?: Point, read?: Fact) {
    const store = this.#store;
    const held = read ?? store.state.held?.fact;
    store.cancel();
    const { x: tx, y: ty, k } = this.#view.transform;
    const { width, height } = this.#view.size;
    const corner = at ?? { x: (Math.max(16, width / 2 - 160 - box.width * k / 2) - tx) / k, y: (Math.max(16, height / 2 - 140) - ty) / k };
    const ghost = { at: corner, read: held, draft: { name: '', result: '', type: held?.type ?? 'bool' } };
    const place = (form: { width: number; height: number }): Point => {
      const node = this.#ghostBox(store.state, ghost);
      const screen = this.#toCanvas(corner.x, corner.y);
      const right = screen.x + node.width * k + 12;
      if (right + form.width <= width - 8) return { x: right, y: screen.y };
      const below = screen.y + node.height * k + 12;
      if (below + form.height <= height - 8) return { x: screen.x, y: below };
      return { x: screen.x - form.width - 12, y: screen.y };
    };
    this.#forms.newRule(place, held, name => {
      store.select({ rule: name, wire: undefined });
      this.#focusWhenDrawn = name;
    }, {
      changed: draft => {
        ghost.draft = draft;
        this.#ghost = ghost;
        this.#drawGhost(this.#store.state);
        this.#scaleCompact();
      },
      closed: () => {
        if (this.#ghost !== ghost) return;
        this.#ghost = undefined;
        if (this.#ghostNode) this.#compactStates.delete(this.#ghostNode);
        this.#drawGhost(this.#store.state);
      },
    });
  }

  #onKey(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : undefined;
    if (!target || target.closest('.graph-ui, .graph-tools') || target instanceof HTMLInputElement) return;
    const store = this.#store;
    const state = store.state;
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Fix links handle their own Enter and Space.
    if (target instanceof HTMLButtonElement) return;

    const node = target.closest<SVGGElement>('[data-rule]');
    const row = target.closest<SVGGElement>('[data-fact-source]');
    const label = target.closest<SVGGElement>('.graph-label');
    const rule = node?.dataset.rule ?? (this.#current?.kind === 'rule' ? this.#current.id : undefined);
    const wire = label?.dataset.wire ? state.graph.wires.find(candidate => wireKey(candidate) === label.dataset.wire) : undefined;
    const direction = directions[event.key];

    if (['+', '=', '-', '_', '0', '1'].includes(event.key)) {
      handled();
      if (event.key === '0') this.#view.fit();
      else if (event.key === '1') this.#view.actual(this.#rectOf(rule));
      else this.#view.zoomBy(event.key === '+' || event.key === '=' ? 1.2 : 1 / 1.2);
      return;
    }

    if (state.held) {
      if (direction) {
        handled();
        const from = state.held.over ?? rule;
        const next = stepTarget(this.#placement?.nodes ?? new Map(), validTargets(state), from, direction);
        if (!next) { this.#announce(`No rule can take ${state.held.fact.name}.`); return; }
        store.aim(next);
        this.#moveTo({ kind: 'rule', id: next });
        const fact = state.held.fact;
        this.#announce(`${next}. Enter adds ${fact.name} ${fact.type}.`);
        return;
      }
      if (event.key === 'Enter') {
        handled();
        if (!state.held.over && rule) store.aim(rule);
        void store.drop();
        return;
      }
      if (event.key === 'Escape') { handled(); store.cancel(); return; }
    }

    if (direction && wire && !event.shiftKey) {
      handled();
      if (direction === 'up') this.#moveTo({ kind: 'rule', id: wire.from });
      else if (direction === 'down') this.#moveTo({ kind: 'rule', id: wire.to });
      else {
        const siblings = wiresAt(state.graph, this.#placement?.labels ?? new Map(), wire.to, 'in');
        const index = siblings.findIndex(candidate => wireKey(candidate) === wireKey(wire));
        const next = siblings[(index + (direction === 'right' ? 1 : -1) + siblings.length) % siblings.length];
        if (next) this.#selectWire(next);
      }
      return;
    }
    if (direction && rule) {
      handled();
      if (event.shiftKey && (direction === 'up' || direction === 'down')) {
        const wires = wiresAt(state.graph, this.#placement?.labels ?? new Map(), rule, direction === 'up' ? 'in' : 'out');
        if (wires[0]) this.#selectWire(wires[0]);
        else this.#announce(direction === 'up' ? `${rule} reads no fact from another rule.` : `No rule reads from ${rule}.`);
        return;
      }
      const next = neighbour(state.graph, this.#placement?.nodes ?? new Map(), rule, direction);
      if (next) this.#moveTo({ kind: 'rule', id: next });
      return;
    }

    switch (event.key) {
      case 'Enter':
        if (!rule || wire) return;
        handled();
        store.select({ rule, wire: undefined });
        focusFirstIn(document.querySelector('[data-region="code"]'));
        return;
      case ' ':
        if (wire) { handled(); store.select({ wire }); return; }
        if (!rule) return;
        handled();
        store.select({ rule, wire: undefined });
        return;
      case 'w':
      case 'W': {
        const owner = rule ? state.graph.rules.get(rule) : undefined;
        if (!owner) return;
        handled();
        if (row?.dataset.fact) { store.hold(row.dataset.fact); return; }
        if (!owner.produces.length) { this.#announce(`${owner.id} produces no fact.`); return; }
        const index = owner.produces.findIndex(fact => fact.name === state.held?.fact.name);
        store.hold(owner.produces[(index + 1) % owner.produces.length]!.name);
        return;
      }
      case 'a':
      case 'A':
        if (!rule) return;
        handled();
        this.#root.dispatchEvent(new CustomEvent('infergo:add-read', { bubbles: true, detail: { rule } }));
        return;
      case 'n':
      case 'N': {
        handled();
        const rect = this.#rectOf(rule);
        this.#openNewRule(rect ? { x: rect.x, y: rect.y + rect.height + 40 } : undefined);
        return;
      }
      case 'F2': {
        handled();
        if (row?.dataset.fact) { this.#renameFact(row.dataset.fact, row); return; }
        if (rule) this.#renameRule(rule);
        return;
      }
      case 'Delete':
      case 'Backspace': {
        const chosen = wire ?? (!node ? state.selection.wire : undefined);
        if (chosen) {
          handled();
          void store.apply({ op: 'remove_read', rule: chosen.to, fact: chosen.fact });
          return;
        }
        if (event.key === 'Delete' && rule) {
          handled();
          const rect = this.#rectOf(rule);
          const at = rect ? this.#toCanvas(rect.x, rect.y + 24) : { x: 16, y: 16 };
          this.#forms.confirmDelete(rule, at, () => this.#announce(`Deleted ${rule}.`));
        }
        return;
      }
      case 'Escape':
        if (state.selection.wire) { handled(); store.select({ wire: undefined }); }
        return;
    }
  }

  #selectWire(wire: Wire) {
    this.#store.select({ wire });
    this.#moveTo({ kind: 'wire', key: wireKey(wire) });
    this.#announce(`Wire ${wire.fact} from ${wire.from} to ${wire.to}. Delete removes it.`);
  }

  #renameRule(rule: string) {
    const rect = this.#rectOf(rule);
    const node = this.#input?.nodes.find(candidate => candidate.id === rule);
    if (!rect || !node) return;
    const at = this.#toCanvas(rect.x + box.pad - 6, rect.y + node.name.top);
    this.#forms.rename('rule', rule, at, rect.width * this.#view.transform.k, renamed => {
      this.#store.select({ rule: renamed });
      this.#focusWhenDrawn = renamed;
    });
  }

  #renameFact(fact: string, row: Element) {
    const bounds = row.getBoundingClientRect();
    const at = this.#view.local({ x: bounds.left, y: bounds.top });
    this.#forms.rename('fact', fact, at, bounds.width, () => {
      if (this.#current?.kind === 'rule') this.#focusWhenDrawn = this.#current.id;
    });
  }

  #announce(text: string) {
    this.#shell.announce(text);
  }
}

/**
 * The short reason an aimed rule refuses the held fact, drawn on the node. The
 * status line and the sheet carry the full sentence with the cycle's path.
 */
function refusalNote(verdict: Verdict, fact: string, rule: string, state: State): string {
  if (verdict.ok) return '';
  switch (verdict.reason) {
    case 'cycle': return 'No drop: it would close a cycle.';
    case 'reads': return `No drop: already reads ${fact}.`;
    case 'produces': return `No drop: produces ${fact}.`;
    case 'unsupported': return `No drop. ${verdictMessage(verdict, fact, rule, state.graph)}.`;
  }
}

type Point = { x: number; y: number };

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The point at `t` (0 to 1) along a cubic Bezier curve. */
function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}
