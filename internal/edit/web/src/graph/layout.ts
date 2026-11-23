// What each node and wire label contains and how big it is, then dagre places
// them. Pure: text is measured through a function the caller passes, so the
// unit tests run it under Node with a fake measure. index.ts measures with a
// canvas and draws exactly the boxes built here.
import { Graph as Dagre, layout as dagreLayout, type EdgeLabel, type GraphLabel, type NodeLabel } from '@dagrejs/dagre';
import { wireKey, type Graph, type Wire } from '../derive';
import type { Diagnostic, Fact, Fix, Rule, Snapshot, Trace } from '../protocol';

/** The fonts the canvas draws with. graph.css uses the same sizes. */
export type Font = 'name' | 'port' | 'type' | 'prose' | 'value' | 'note' | 'label';
export type Measure = (text: string, font: Font) => number;

/** Node geometry, in graph units (CSS pixels at Actual size). */
export const box = {
  width: 280,
  pad: 14,
  row: 18,
  nameLine: 19,
  proseLine: 18,
  noteLine: 16,
  fixHeight: 20,
  fixGap: 14,
  pin: 13, // the square and the space after it
};

const contentWidth = box.width - 2 * box.pad;

/** One fact row in a node. `origin` says where a read comes from: another rule (filled square), an input (hollow), or nowhere. */
export type FactRow = {
  part: 'read' | 'produce';
  fact: string;
  type: string;
  /** Text right of the name: the type, or both types on a mismatch. */
  typeText: string;
  /** True when the name and type do not fit on one line: the type moves to the line below, right-aligned. */
  typeBelow: boolean;
  origin: 'rule' | 'input' | 'missing';
  pending: boolean;
  error: boolean;
  lines: string[];
  top: number;
  height: number;
  /** The produce row's value line, when values are shown. */
  value?: { text: string; tone: 'plain' | 'error'; top: number };
};

/** A fix link placed inside a node or under a wire label, relative to its owner. */
export type PlacedFix = { fix: Fix; x: number; y: number; width: number };

/** A finding, the refusal reason, or the pruned word, drawn at the bottom of a node. */
export type NodeNote = { key: string; tone: 'error' | 'warning' | 'refused'; lines: string[]; top: number; fixes: PlacedFix[] };

/** Everything drawn inside one node, with positions relative to its top-left corner. */
export type NodeBox = {
  id: string;
  width: number;
  height: number;
  reads: FactRow[];
  readsDivider?: number;
  name: { lines: string[]; top: number };
  problems?: { text: string; tone: 'error' | 'warning'; top: number; ownLine: boolean };
  requirement: { lines: string[]; top: number };
  producesDivider?: number;
  produces: FactRow[];
  notesDivider?: number;
  notes: NodeNote[];
  /** Accessible name: what it reads, what it produces, how many problems. */
  label: string;
};

/** A wire label: the fact, both types on a mismatch, and a fix link on a cycle. */
export type LabelBox = { key: string; wire: Wire; text: string; width: number; height: number; fix?: PlacedFix };

/**
 * What the canvas knows about problems and values, gathered once per render
 * from State so building a node needs nothing else.
 */
export type Findings = {
  /** Diagnostics drawn on each rule's node. */
  byRule: ReadonlyMap<string, Diagnostic[]>;
  /** Reads with no producer, as `rule>fact`. */
  missing: ReadonlySet<string>;
  /** Type mismatches by `rule>fact`: the type the producer gives. */
  mismatch: ReadonlyMap<string, string>;
  /** Produces rows with a duplicate producer, as `rule>fact`. */
  duplicate: ReadonlySet<string>;
  /** Wires on a reported cycle, by wireKey, with the fix that removes each one. */
  cycleWires: ReadonlyMap<string, Fix | undefined>;
  pruned: ReadonlySet<string>;
  /** Problem counts per rule. */
  counts: ReadonlyMap<string, { errors: number; warnings: number }>;
};

/** Per node extras that are drawn but never change the layout: the aimed read and the refusal reason. */
export type Decoration = { pending?: Fact; refusal?: string };

export const noFindings: Findings = {
  byRule: new Map(), missing: new Set(), mismatch: new Map(), duplicate: new Set(), cycleWires: new Map(), pruned: new Set(), counts: new Map(),
};

const rf = (rule: string, fact: string) => `${rule}>${fact}`;

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Sorts the compiler's diagnostics onto nodes, rows, and wires. Diagnostics about rules the model does not have are left to other regions. */
export function gatherFindings(graph: Graph, diagnostics: readonly Diagnostic[], pruned: readonly string[]): Findings {
  const byRule = new Map<string, Diagnostic[]>();
  const missing = new Set<string>();
  const mismatch = new Map<string, string>();
  const duplicate = new Set<string>();
  const cycleWires = new Map<string, Fix | undefined>();
  const counts = new Map<string, { errors: number; warnings: number }>();
  const count = (rule: string, diagnostic: Diagnostic) => {
    const entry = counts.get(rule) ?? { errors: 0, warnings: 0 };
    if (diagnostic.severity === 'error') entry.errors++;
    else entry.warnings++;
    counts.set(rule, entry);
  };
  for (const diagnostic of diagnostics) {
    const { rule, fact } = diagnostic;
    if (diagnostic.kind === 'cycle') {
      const members = diagnostic.related?.length ? diagnostic.related : rule ? [rule] : [];
      for (const [index, from] of members.entries()) {
        const to = members[(index + 1) % members.length]!;
        for (const wire of graph.wires) {
          if (wire.from !== from || wire.to !== to) continue;
          const fix = diagnostic.fixes.find(candidate => candidate.op.op === 'remove_read' && candidate.op.rule === wire.to && candidate.op.fact === wire.fact);
          if (!cycleWires.has(wireKey(wire)) || fix) cycleWires.set(wireKey(wire), fix);
        }
      }
      for (const member of new Set(members)) if (graph.rules.has(member)) count(member, diagnostic);
      if (rule && graph.rules.has(rule)) push(byRule, rule, diagnostic);
      continue;
    }
    if (!rule || !graph.rules.has(rule)) continue;
    push(byRule, rule, diagnostic);
    count(rule, diagnostic);
    if (!fact) continue;
    if (diagnostic.kind === 'missing_producer') missing.add(rf(rule, fact));
    if (diagnostic.kind === 'type_mismatch') mismatch.set(rf(rule, fact), producedType(graph, fact, diagnostic.related?.[0]) ?? '?');
    if (diagnostic.kind === 'duplicate_producer') {
      duplicate.add(rf(rule, fact));
      for (const other of diagnostic.related ?? []) duplicate.add(rf(other, fact));
    }
  }
  return { byRule, missing, mismatch, duplicate, cycleWires, pruned: new Set(pruned), counts };
}

/** The type a fact has where it comes from: its producer's result, else the input field. */
function producedType(graph: Graph, fact: string, producer?: string): string | undefined {
  const rule = producer ? graph.rules.get(producer) : undefined;
  const fromRule = rule?.produces.find(produce => produce.name === fact)?.type;
  if (fromRule) return fromRule;
  const info = graph.facts.get(fact);
  return info?.input ? info.type : info?.producers[0] ? graph.rules.get(info.producers[0])?.produces.find(produce => produce.name === fact)?.type : undefined;
}

/** Wraps text at spaces, and inside a word too long for one line, so nothing is clipped. */
export function wrap(text: string, width: number, font: Font, measure: Measure): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue;
    if (line && measure(`${line} ${word}`, font) <= width) { line += ` ${word}`; continue; }
    if (line) lines.push(line);
    line = '';
    for (const character of word) {
      if (line && measure(line + character, font) > width) { lines.push(line); line = ''; }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** Lays fix links out left to right, wrapping into rows. Returns the links and the height they take. */
function placeFixes(fixes: readonly Fix[], top: number, measure: Measure): { placed: PlacedFix[]; height: number } {
  const placed: PlacedFix[] = [];
  let x = 0;
  let y = top;
  for (const fix of fixes) {
    const width = Math.min(contentWidth, Math.ceil(measure(fix.label, 'note')) + 2);
    if (x > 0 && x + width > contentWidth) { x = 0; y += box.fixHeight + 2; }
    placed.push({ fix, x: box.pad + x, y, width });
    x += width + box.fixGap;
  }
  return { placed, height: fixes.length ? y - top + box.fixHeight + 2 : 0 };
}

/** The short sentence a node shows for a diagnostic. The full compiler message stays in the sheet. */
export function findingText(diagnostic: Diagnostic, graph: Graph, rule: Rule): string {
  const fact = diagnostic.fact ?? '';
  switch (diagnostic.kind) {
    case 'missing_producer': return `No input or rule produces ${fact}.`;
    case 'type_mismatch': {
      const read = rule.reads.find(candidate => candidate.name === fact)?.type ?? '?';
      const producer = diagnostic.related?.[0];
      const source = producedType(graph, fact, producer) ?? '?';
      return `${fact} is ${source} from ${producer ?? 'the input'} and ${read} here.`;
    }
    case 'duplicate_producer': return `${fact} is also produced by ${diagnostic.related?.join(', ') || 'another rule'}.`;
    case 'cycle': {
      const members = diagnostic.related?.length ? diagnostic.related : [rule.id];
      return `On a cycle: ${[...members, members[0]].join(' → ')}.`;
    }
    case 'unused_rule': return 'Not needed by any output.';
    case 'go': return `${diagnostic.line ? `Line ${diagnostic.line}: ` : ''}${diagnostic.message}`;
    default: return diagnostic.message.charAt(0).toUpperCase() + diagnostic.message.slice(1);
  }
}

/** A captured value as the viewer prints it: digits grouped, cents marked. */
export function formatValue(fact: string, raw: string | undefined): string {
  if (raw === undefined) return 'Unavailable';
  return /^\d+$/.test(raw) ? `${BigInt(raw).toLocaleString('en-US')}${/(?:_cents|Cents)$/.test(fact) ? ' c' : ''}` : raw;
}

function valueFor(fact: string, trace: Trace | undefined): { text: string; tone: 'plain' | 'error' } {
  if (!trace) return { text: 'Not evaluated', tone: 'plain' };
  switch (trace.kind) {
    case 'succeeded': return { text: formatValue(fact, trace.facts?.[fact]), tone: 'plain' };
    case 'failed': return { text: `Failed. ${trace.error ?? ''}`.trim(), tone: 'error' };
    case 'canceled': return { text: `Canceled. ${trace.error ?? ''}`.trim(), tone: 'error' };
    case 'not_run': return { text: 'Not run', tone: 'plain' };
  }
}

/** Builds one node's contents. Pass a decoration only for drawing; the layout uses the plain node. */
export function buildNode(rule: Rule, graph: Graph, findings: Findings, measure: Measure, snapshot?: Snapshot, decoration: Decoration = {}): NodeBox {
  let y = 12;

  const factRow = (part: FactRow['part'], fact: Fact, extra: Partial<FactRow>): FactRow => {
    const typeText = extra.typeText ?? fact.type;
    const typeWidth = measure(typeText, 'type');
    const text = extra.pending ? `+ ${fact.name}` : fact.name;
    const full = contentWidth - box.pin;
    // Name and type share a line when they fit. Otherwise the type takes the
    // next line, so a long name breaks only when it is wider than the node.
    const typeBelow = measure(text, 'port') + 10 + typeWidth > full;
    const lines = wrap(text, typeBelow ? full : full - typeWidth - 10, 'port', measure);
    const row: FactRow = {
      part, fact: fact.name, type: fact.type, typeText, typeBelow, origin: 'rule', pending: false, error: false,
      lines, top: y, height: (lines.length + (typeBelow ? 1 : 0)) * box.row, ...extra,
    };
    y += row.height;
    return row;
  };

  const reads: FactRow[] = [];
  for (const read of rule.reads) {
    const key = rf(rule.id, read.name);
    const info = graph.facts.get(read.name);
    const origin: FactRow['origin'] = findings.missing.has(key) || (!info?.input && !info?.producers.length) ? 'missing' : info?.producers.length ? 'rule' : 'input';
    const produced = findings.mismatch.get(key);
    reads.push(factRow('read', read, {
      origin,
      error: origin === 'missing' || produced !== undefined,
      ...(produced !== undefined ? { typeText: `${read.type} ≠ ${produced}` } : {}),
    }));
  }
  if (decoration.pending) {
    const info = graph.facts.get(decoration.pending.name);
    reads.push(factRow('read', decoration.pending, { origin: info?.producers.length ? 'rule' : 'input', pending: true }));
  }
  let readsDivider: number | undefined;
  if (reads.length) { readsDivider = y + 3; y += 8; }

  const counts = findings.counts.get(rule.id);
  const problemText = counts && (counts.errors || counts.warnings)
    ? [counts.errors ? `${counts.errors} ${counts.errors === 1 ? 'error' : 'errors'}` : '', counts.warnings ? `${counts.warnings} ${counts.warnings === 1 ? 'warning' : 'warnings'}` : ''].filter(Boolean).join(', ')
    : '';
  const problemWidth = problemText ? measure(problemText, 'note') + 12 : 0;
  const nameLines = wrap(`${rule.id}()`, contentWidth, 'name', measure);
  const lastNameWidth = measure(nameLines[nameLines.length - 1] ?? '', 'name');
  const problemsInline = !!problemText && lastNameWidth + problemWidth <= contentWidth;
  const name = { lines: nameLines, top: y };
  y += 22 + (nameLines.length - 1) * box.nameLine;
  let problems: NodeBox['problems'];
  if (problemText) {
    const tone = counts?.errors ? 'error' : 'warning';
    if (problemsInline) problems = { text: problemText, tone, top: name.top + (nameLines.length - 1) * box.nameLine, ownLine: false };
    else { problems = { text: problemText, tone, top: y, ownLine: true }; y += box.noteLine; }
  }

  const requirement = { lines: rule.requirement ? wrap(rule.requirement, contentWidth, 'prose', measure) : [], top: y };
  y += requirement.lines.length * box.proseLine;

  let producesDivider: number | undefined;
  const produces: FactRow[] = [];
  if (rule.produces.length) {
    producesDivider = y + 4;
    y += 8;
    const trace = snapshot?.trace.find(candidate => candidate.rule === rule.id);
    for (const produce of rule.produces) {
      const row = factRow('produce', produce, { error: findings.duplicate.has(rf(rule.id, produce.name)) });
      if (snapshot) {
        const value = valueFor(produce.name, trace);
        row.value = { ...value, top: y };
        y += 24;
      }
      produces.push(row);
    }
  }

  const notes: NodeNote[] = [];
  let notesDivider: number | undefined;
  const sources: { key: string; tone: NodeNote['tone']; text: string; fixes: readonly Fix[] }[] = [];
  if (decoration.refusal) sources.push({ key: 'refusal', tone: 'refused', text: decoration.refusal, fixes: [] });
  for (const [index, diagnostic] of (findings.byRule.get(rule.id) ?? []).entries()) {
    // A cycle's fixes sit on the wires they remove; the rest stay on the node.
    const fixes = diagnostic.kind === 'cycle'
      ? diagnostic.fixes.filter(fix => ![...findings.cycleWires.values()].includes(fix))
      : diagnostic.fixes;
    sources.push({ key: `${index}:${diagnostic.kind}`, tone: diagnostic.severity, text: findingText(diagnostic, graph, rule), fixes });
  }
  if (findings.pruned.has(rule.id) && !sources.some(source => source.key.endsWith(':unused_rule'))) {
    sources.push({ key: 'pruned', tone: 'warning', text: 'Not needed by any output.', fixes: [] });
  }
  if (sources.length) {
    notesDivider = y + 2;
    y += 8;
    for (const source of sources) {
      const lines = wrap(source.text, contentWidth, 'note', measure);
      const top = y;
      y += lines.length * box.noteLine;
      const { placed, height } = placeFixes(source.fixes, y + 2, measure);
      y += height + 4;
      notes.push({ key: source.key, tone: source.tone, lines, top, fixes: placed });
    }
  }
  y += 6;

  const readText = rule.reads.length ? `Reads ${rule.reads.map(read => `${read.name} ${read.type}${graph.facts.get(read.name)?.input ? ', an input' : ''}`).join('; ')}.` : 'Reads nothing.';
  const produceText = rule.produces.length ? `Produces ${rule.produces.map(produce => `${produce.name} ${produce.type}`).join('; ')}.` : 'Produces nothing.';
  const problemCount = (counts?.errors ?? 0) + (counts?.warnings ?? 0);
  const label = `${rule.id}. ${readText} ${produceText} ${problemCount ? `${problemCount} ${problemCount === 1 ? 'problem' : 'problems'}` : 'No problems'}.`;

  return {
    id: rule.id, width: box.width, height: Math.ceil(y), reads, readsDivider, name, problems, requirement,
    producesDivider, produces, notesDivider, notes, label,
  };
}

/** Builds one wire label: the fact, both types on a mismatch, and a Remove this wire link on a cycle. */
export function buildLabel(wire: Wire, graph: Graph, findings: Findings, measure: Measure): LabelBox {
  const key = wireKey(wire);
  const produced = findings.mismatch.get(rf(wire.to, wire.fact));
  const read = graph.rules.get(wire.to)?.reads.find(candidate => candidate.name === wire.fact)?.type;
  const text = produced !== undefined ? `${wire.fact} ${produced} ≠ ${read ?? '?'}` : wire.fact;
  let width = Math.ceil(measure(text, 'label')) + 22;
  let height = 24;
  const cycleFix = findings.cycleWires.get(key);
  let fix: PlacedFix | undefined;
  if (cycleFix) {
    const fixWidth = Math.ceil(measure('Remove this wire', 'note')) + 2;
    width = Math.max(width, fixWidth + 22);
    fix = { fix: { ...cycleFix, label: 'Remove this wire' }, x: 0, y: height, width: fixWidth };
    height += box.fixHeight + 4;
  }
  return { key, wire, text, width, height, fix };
}

/** The input to dagre, and a signature that changes only when a position could change. */
export type LayoutInput = { nodes: NodeBox[]; labels: LabelBox[]; signature: string };

export function buildLayoutInput(graph: Graph, findings: Findings, measure: Measure, snapshot?: Snapshot): LayoutInput {
  const nodes = [...graph.rules.values()].map(rule => buildNode(rule, graph, findings, measure, snapshot));
  const labels = graph.wires.map(wire => buildLabel(wire, graph, findings, measure));
  const signature = JSON.stringify([nodes.map(node => [node.id, node.height]), labels.map(label => [label.key, label.width, label.height])]);
  return { nodes, labels, signature };
}

export type Rect = { x: number; y: number; width: number; height: number };
/** Where dagre put things, in graph units. Node and label rects are top-left based. */
export type Placement = {
  nodes: Map<string, Rect>;
  labels: Map<string, Rect>;
  wires: Map<string, { x: number; y: number }[]>;
  bounds: Rect;
};

/** Runs dagre, top to bottom as the viewer does. Throws when dagre returns geometry that cannot be drawn. */
export function place(input: LayoutInput): Placement {
  const graph = new Dagre<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
  graph.setGraph({ rankdir: 'TB', nodesep: 36, edgesep: 24, ranksep: 70, marginx: 28, marginy: 28 });
  for (const node of input.nodes) graph.setNode(node.id, { width: node.width, height: node.height });
  for (const label of input.labels) {
    graph.setEdge(label.wire.from, label.wire.to, { width: label.width, height: label.height, labelpos: 'c' }, label.key);
  }
  dagreLayout(graph);
  const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);
  const nodes = new Map<string, Rect>();
  for (const node of input.nodes) {
    const at = graph.node(node.id);
    if (!at || !finite(at.x) || !finite(at.y)) throw new Error(`Invalid rule geometry: ${node.id}`);
    nodes.set(node.id, { x: at.x - node.width / 2, y: at.y - node.height / 2, width: node.width, height: node.height });
  }
  const labels = new Map<string, Rect>();
  const wires = new Map<string, { x: number; y: number }[]>();
  for (const label of input.labels) {
    const edge = graph.edge({ v: label.wire.from, w: label.wire.to, name: label.key });
    const points = edge?.points ?? [];
    if (!edge || !finite(edge.x) || !finite(edge.y) || points.length < 2 || !points.every(point => finite(point.x) && finite(point.y))) {
      throw new Error(`Invalid wire geometry: ${label.key}`);
    }
    labels.set(label.key, { x: edge.x - label.width / 2, y: edge.y - label.height / 2, width: label.width, height: label.height });
    wires.set(label.key, points.map(point => ({ x: point.x, y: point.y })));
  }
  const { width, height } = graph.graph();
  return { nodes, labels, wires, bounds: { x: 0, y: 0, width: finite(width) ? width : 1, height: finite(height) ? height : 1 } };
}

/** Moves a placement by (dx, dy). Used to keep the anchored node where it was on screen. */
export function shifted(placement: Placement, dx: number, dy: number): Placement {
  if (!dx && !dy) return placement;
  const move = (rect: Rect): Rect => ({ ...rect, x: rect.x + dx, y: rect.y + dy });
  return {
    nodes: new Map([...placement.nodes].map(([key, rect]) => [key, move(rect)])),
    labels: new Map([...placement.labels].map(([key, rect]) => [key, move(rect)])),
    wires: new Map([...placement.wires].map(([key, points]) => [key, points.map(point => ({ x: point.x + dx, y: point.y + dy }))])),
    bounds: move(placement.bounds),
  };
}

/**
 * The shift that keeps an anchor rule's top-left corner where it was: the
 * selected rule first, else the rule under the pointer. When neither is in
 * both placements, the graph keeps the origin it had, so nothing jumps by the
 * earlier shifts.
 */
export function anchorShift(previous: Placement | undefined, next: Placement, anchors: readonly (string | undefined)[]): { dx: number; dy: number } {
  if (!previous) return { dx: 0, dy: 0 };
  for (const anchor of anchors) {
    if (!anchor) continue;
    const before = previous.nodes.get(anchor);
    const after = next.nodes.get(anchor);
    if (before && after) return { dx: before.x - after.x, dy: before.y - after.y };
  }
  return { dx: previous.bounds.x - next.bounds.x, dy: previous.bounds.y - next.bounds.y };
}
