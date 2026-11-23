// The graph canvas: every rule as a node and every wire as a dashed, labelled
// arrow, laid out by dagre top to bottom as in the viewer. It turns pointer
// and keyboard input into store actions (pick up, aim, drop, select, apply)
// and draws State: held targets, the pending read and wire, a refused cycle,
// diagnostics with their fixes, the lit fact, and Find. main.ts mounts it once.
//
// Structure, built once in mount and updated in place on every change:
//   heading       title and the toolbar (New rule, zoom, Fit map, Actual size, List)
//   viewport      data-drop-zone="canvas"; pans and zooms through View
//     svg > g.view   wires, wire labels, the pending layer, nodes
//     .graph-scene   HTML fix links, scaled with the graph so they stay crisp
//     .graph-ui      unscaled inline forms (New rule, rename, delete)
import { verdictMessage, wireKey, type Verdict, type Wire } from '../derive';
import { h, setText } from '../dom';
import { beginDrag, beginDragOnly, type ZoneDrop } from '../drag';
import type { Fact, Op, Snapshot } from '../protocol';
import type { Region, Shell } from '../region';
import { matchesQuery, pendingRead, validTargets, type State, type Store } from '../store';
import { Forms } from './forms';
import { neighbour, stepTarget, wiresAt, type Direction } from './keys';
import {
  anchorShift, box, buildLabel, buildLayoutInput, buildNode, gatherFindings, place, shifted,
  type Findings, type Font, type LabelBox, type LayoutInput, type Measure, type NodeBox, type Placement, type PlacedFix, type Rect,
} from './layout';
import { moveTo, Parts, round, setAttributes, svg } from './paint';
import { fitZoom, View, type Transform } from './view';

export const mount: Region = (root, store, shell) => {
  new Canvas(root, store, shell);
};

/** The element with roving focus: a rule's node or a wire's label. */
type Current = { kind: 'rule'; id: string } | { kind: 'wire'; key: string };

const directions: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

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
  #nodeLayer = svg('g', { class: 'graph-nodes' });
  #scene = h('div', { class: 'graph-scene' });
  #ui = h('div', { class: 'graph-ui' });
  #message = h('p', { class: 'graph-message', hidden: true });

  #wires = new Parts(this.#wireLayer);
  #labels = new Parts(this.#labelLayer);
  #nodes = new Parts(this.#nodeLayer);
  #nodeFixes = new Parts<HTMLDivElement>(this.#scene, () => h('div', { class: 'graph-fixes' }));
  #inner = new WeakMap<Element, Parts>();
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
    this.#viewGroup.append(this.#wireLayer, this.#labelLayer, this.#nodeLayer, this.#pendingLayer);
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
  }

  #rectOf(rule: string | undefined): Rect | undefined {
    return rule ? this.#placement?.nodes.get(rule) : undefined;
  }

  /** Client point of a graph point, for forms placed over the canvas. */
  #toCanvas(x: number, y: number) {
    const { x: tx, y: ty, k } = this.#view.transform;
    return { x: x * k + tx, y: y * k + ty };
  }

  // The first view, once the canvas has a size: the whole map when it fits at
  // a readable size, else Actual size on the selected rule.
  #ensureView() {
    if (this.#viewReady || !this.#placement || !this.#viewport.clientWidth || !this.#viewport.clientHeight) return;
    this.#viewReady = true;
    this.#view.setBounds(this.#placement.bounds);
    const k = fitZoom(this.#placement.bounds, this.#viewport.clientWidth, this.#viewport.clientHeight);
    if (k >= 0.6) this.#view.fit();
    else this.#view.actual(this.#rectOf(this.#store.state.selection.rule));
  }

  // ---- Render -------------------------------------------------------------

  #render() {
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
    this.#draw(state, findings, snapshot);
    this.#ensureView();
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
      const element = this.#nodes.part(rule.id, '', g => {
        g.append(svg('rect', { class: 'box' }), svg('rect', { class: 'ring' }));
        this.#inner.set(g, new Parts(g));
      });
      setAttributes(element, {
        class: classes, 'data-rule': rule.id, 'data-drop-rule': rule.id, role: 'group', 'aria-roledescription': 'rule',
        'aria-label': node.label, 'aria-current': selection.rule === rule.id ? 'true' : undefined,
        'aria-keyshortcuts': 'Enter W A F2 Delete N',
      });
      moveTo(element, rect.x, rect.y);
      this.#drawNode(element, node, state);
      this.#drawNodeFixes(rule.id, rect, node, classes.includes(' dim'));
    }
    this.#nodes.end();

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
      this.#drawLabel(label, rect, classes, wire);
    }
    this.#wires.end();
    this.#labels.end();
    this.#nodeFixes.end();

    this.#drawPending(state, drawn);
    this.#syncTabStops();
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
      g.replaceChildren(
        svg('rect', { class: 'label-box', x: 0, y: 0, width: label.width, height: 24 }),
        svg('text', { class: 'label-text', x: label.width / 2, y: 16 }, label.text),
      );
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
          // label is left out when it would cover a rule or another label.
          children.push(...this.#floatingLabel([start, c1, c2, end], [0.82, 0.18, 0.5, 0.65, 0.35], `+ ${held.fact.name}`, 'pending-label', drawn, false));
        } else {
          children.push(svg('path', { class: 'pending-wire', d: `M${end.x - 56},${end.y} H${end.x}`, 'marker-end': 'url(#graph-arrow-teal)' }));
        }
      } else if (held.verdict.reason === 'cycle' && from) {
        const reach = Math.max(from.x + from.width, target.x + target.width) + 70;
        const start = { x: from.x + from.width, y: from.y + from.height / 2 };
        const end = { x: target.x + target.width, y: target.y + Math.min(targetBox.height / 2, 40) };
        const c1 = { x: reach, y: start.y }, c2 = { x: reach, y: end.y };
        children.push(svg('path', { class: 'closing-wire', d: `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`, 'marker-end': 'url(#graph-arrow-amber)' }));
        children.push(...this.#floatingLabel([start, c1, c2, end], [0.5, 0.35, 0.65, 0.2, 0.8], 'would close the loop', 'closing-label', drawn));
      }
    }
    this.#pendingLayer.replaceChildren(...children);
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
      const at = this.#view.local({ x: detail.clientX, y: detail.clientY });
      this.#openNewRule(at, info ? { name: info.name, type: info.type } : undefined);
    });

    this.#root.addEventListener('keydown', event => this.#onKey(event));
  }

  #openNewRule(at?: { x: number; y: number }, read?: Fact) {
    const store = this.#store;
    const held = read ?? store.state.held?.fact;
    store.cancel();
    const point = at ?? { x: this.#viewport.clientWidth / 2 - 150, y: Math.max(16, this.#viewport.clientHeight / 2 - 140) };
    this.#forms.newRule(point, held, name => {
      store.select({ rule: name, wire: undefined });
      this.#focusWhenDrawn = name;
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
        const at = rect ? this.#toCanvas(rect.x, rect.y + rect.height + 16) : undefined;
        this.#openNewRule(at);
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

/** The point at `t` (0 to 1) along a cubic Bezier curve. */
function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}
