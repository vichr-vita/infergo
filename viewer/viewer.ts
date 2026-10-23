// Adapted from Inferrum for Infergo snapshots, search, errors, and mobile navigation.
// Licensed under Apache-2.0; see LICENSE-Inferrum.txt.
import { Graph, layout, type GraphLabel, type NodeLabel, type EdgeLabel } from '@dagrejs/dagre';
import { attachDiagramNavigation } from './navigation';

type FactSpec = { name: string; type: string };
type Rule = { id: string; requirement: string; source: string; inputs: FactSpec[]; outputs: FactSpec[] };
type Trace = { rule: string; kind: 'succeeded' | 'failed' | 'canceled' | 'not_run'; error?: string; facts: Record<string, string> | null };
type Snapshot = { id: string; label: string; inputs: Record<string, string>; trace: Trace[]; error?: string };
type ViewerData = { title: string; inputCount: number; outputCount: number; outputs: FactSpec[] | null; rules: Rule[]; edges: { from: number; to: number; fact: string }[]; cases: Snapshot[] };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}, text = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  node.textContent = text;
  return node;
}

function required<T extends Element>(selector: string, type: { new(...args: never[]): T }): T {
  const node = document.querySelector(selector);
  if (!(node instanceof type)) throw new Error(`Missing viewer element: ${selector}`);
  return node;
}

// Go export owns this schema; browser tests exercise the Go-to-DOM boundary.
const data: ViewerData = JSON.parse(required('#infergo-data', HTMLScriptElement).textContent ?? '{}');
const caseSelect = required('#case-select', HTMLSelectElement);
const ruleSelect = required('#rule-select', HTMLSelectElement);
const diagram = required('#diagram', SVGSVGElement);
const inspector = required('#inspector', HTMLElement);
const inspectorHome = required('.workspace', HTMLElement);
const mobile = matchMedia('(max-width: 1100px)');
const list = required('#rule-list', HTMLOListElement);
const search = required('#rule-search', HTMLInputElement);
const rules = new Map(data.rules.map(rule => [rule.id, rule]));
const producers = new Map(data.rules.flatMap(rule => rule.outputs.map(fact => [fact.name, rule.id] as const)));
const caseMap = new Map(data.cases.map(snapshot => [snapshot.id, snapshot]));
let currentCase: Snapshot | undefined;
let currentRule: Rule | undefined;
let facts = new Map<string, string>();
let query = '';
function matches(rule: Rule) {
  return `${rule.id} ${rule.requirement} ${rule.inputs.map(fact => fact.name).join(' ')} ${rule.outputs.map(fact => fact.name).join(' ')}`.toLocaleLowerCase().includes(query);
}
let traces = new Map<string, Trace>();

function formatted(name: string, raw: string | undefined): string {
  if (raw === undefined) return currentCase ? 'Unavailable' : 'Not evaluated';
  // Captured values remain strings. BigInt avoids losing cents above 2^53.
  return /^\d+$/.test(raw) ? `${BigInt(raw).toLocaleString('en-US')}${/(?:_cents|Cents)$/.test(name) ? ' c' : ''}` : raw;
}

function status(rule: Rule): string {
  const trace = traces.get(rule.id);
  if (!trace) return 'Not evaluated';
  switch (trace.kind) {
    case 'succeeded': return 'Succeeded';
    case 'failed': return `Failed. ${trace.error ?? ''}`;
    case 'canceled': return `Canceled. ${trace.error ?? ''}`;
    case 'not_run': return 'Not run';
  }
}

function outputLabel(rule: Rule): string {
  const trace = traces.get(rule.id);
  if (trace && trace.kind !== 'succeeded') return status(rule);
  if (!currentCase) return 'Not evaluated';
  return rule.outputs.map(fact => formatted(fact.name, facts.get(fact.name))).join(' · ') || 'No outputs';
}

function route(caseId: string | undefined, ruleId: string | undefined): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (caseId) params.set('case', caseId);
  if (ruleId) params.set('rule', ruleId);
  return `#${params}`;
}

function select(ruleId: string | undefined, caseId = currentCase?.id, focusInspector = false) {
  const rule = rules.get(ruleId ?? '');
  if (rule && query && !matches(rule)) query = '';
  const hash = route(caseId, ruleId);
  if (location.hash !== hash) history.pushState(null, '', hash);
  render();
  if (focusInspector && matchMedia('(max-width: 1100px)').matches) {
    inspector.scrollIntoView({ block: 'start' });
    inspector.focus({ preventScroll: true });
  }
}

function ruleLink(ruleId: string, label: string) {
  const link = element('a', label);
  link.href = route(currentCase?.id, ruleId);
  link.addEventListener('click', event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    select(ruleId, currentCase?.id, true);
  });
  return link;
}

function renderFacts(target: HTMLUListElement, declarations: FactSpec[], showProducer: boolean) {
  target.replaceChildren();
  if (!declarations.length) { target.append(element('li', 'None')); return; }
  for (const fact of declarations) {
    const row = element('li');
    row.dataset.fact = fact.name;
    row.append(element('code', fact.name, 'fact-name'), element('span', fact.type, 'fact-type'), element('span', formatted(fact.name, facts.get(fact.name)), 'fact-value'));
    if (showProducer) {
      const producer = producers.get(fact.name);
      const origin = producer ? ruleLink(producer, `← ${producer}()`) : element('span', 'Initial input');
      origin.className = 'fact-origin';
      row.append(origin);
    }
    target.append(row);
  }
}

function renderInspector() {
  inspector.hidden = !currentRule;
  if (!currentRule) return;
  required('#rule-title', HTMLElement).textContent = `${currentRule.id}()`;
  inspector.scrollTop = 0;
  const statusNode = required('#rule-status', HTMLElement);
  statusNode.textContent = status(currentRule);
  statusNode.dataset.kind = traces.get(currentRule.id)?.kind ?? 'not_evaluated';
  required('#rule-requirement', HTMLElement).textContent = currentRule.requirement || 'No requirement supplied.';
  required('#source', HTMLElement).textContent = currentRule.source || 'No source excerpt supplied.';
  renderFacts(required('#inputs', HTMLUListElement), currentRule.inputs, true);
  renderFacts(required('#outputs', HTMLUListElement), currentRule.outputs, false);
}

// Lay out once from wrapped names, descriptions, and fact labels. Selecting a case
// updates labels and status without moving the graph or resetting keyboard focus.
const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
graph.setGraph({ rankdir: 'TB', nodesep: 36, edgesep: 24, ranksep: 76, marginx: 28, marginy: 28 });
const measure = document.createElement('canvas').getContext('2d');
const short = (text: string) => Array.from(text).length > 29 ? `${Array.from(text).slice(0, 28).join('')}…` : text;
const nodeWidth = 280;
const contentWidth = nodeWidth - 32;
function widthOf(text: string, font: string) {
  if (!measure) return Array.from(text).length * 9;
  measure.font = font;
  return measure.measureText(text).width;
}

function valueSummary(text: string) {
  let label = short(text);
  while (widthOf(label, '16px Arial') > contentWidth) label = `${Array.from(label).slice(0, -2).join('')}…`;
  return label;
}

// Wrap long tokens too, so generated names and fact IDs stay inside their boxes.
function linesFor(text: string, width: number, font: string) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/)) {
    if (line && widthOf(`${line} ${word}`, font) <= width) { line += ` ${word}`; continue; }
    if (line) lines.push(line);
    line = '';
    for (const character of word) {
      if (line && widthOf(line + character, font) > width) { lines.push(line); line = ''; }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines;
}
const labels = data.rules.map(rule => ({
  name: linesFor(`${rule.id}()`, contentWidth, '600 14px monospace'),
  description: linesFor(rule.requirement || 'No requirement supplied.', contentWidth, '13px Arial'),
}));
for (const [index, label] of labels.entries()) {
  graph.setNode(String(index), { width: nodeWidth, height: 87 + label.name.length * 19 + label.description.length * 18 });
}
const edgeLabels = data.edges.map(edge => linesFor(edge.fact, 220, '12px monospace'));
data.edges.forEach((edge, index) => {
  const lines = edgeLabels[index] ?? [];
  graph.setEdge(String(edge.from), String(edge.to), {
    width: Math.max(0, ...lines.map(line => widthOf(line, '12px monospace'))) + 16,
    height: lines.length * 16 + 10,
    labelpos: 'c',
  }, String(index));
});
if (data.rules.length) layout(graph);

const nodeElements: { rule: Rule; node: SVGAElement; value: SVGTextElement; title: SVGTitleElement }[] = [];
const edgeElements: { from: string; to: string; path: SVGPathElement; label: SVGGElement }[] = [];
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
let lastAnimatedRoute = '';

function stopEdgeAnimations() {
  for (const { path } of edgeElements) for (const animation of path.getAnimations()) animation.cancel();
}
motionPreference.addEventListener('change', stopEdgeAnimations);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopEdgeAnimations(); });

function buildDiagram() {
  const bounds = graph.graph();
  diagram.setAttribute('viewBox', `0 0 ${bounds.width ?? 1} ${bounds.height ?? 1}`);
  diagram.setAttribute('width', String(bounds.width ?? 1));
  diagram.setAttribute('height', String(bounds.height ?? 1));
  const defs = svg('defs');
  for (const [id, color] of [['arrow', '#888'], ['arrow-selected', '#74dfd0']]) {
    const marker = svg('marker', { id: id ?? '', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color ?? '#888' }));
    defs.append(marker);
  }
  diagram.append(defs);
  data.edges.forEach((edge, index) => {
    const geometry = graph.edge({ v: String(edge.from), w: String(edge.to), name: String(index) });
    const points = geometry?.points ?? [];
    const path = svg('path', { class: 'edge', d: points.map((point, i) => `${i ? 'L' : 'M'}${point.x},${point.y}`).join(' '), 'marker-end': 'url(#arrow)' });
    path.append(svg('title', {}, edge.fact));
    diagram.append(path);
    const label = svg('g', { class: 'edge-label', 'data-fact': edge.fact });
    if (geometry?.x !== undefined && geometry.y !== undefined && geometry.width !== undefined && geometry.height !== undefined) {
      const x = geometry.x, y = geometry.y;
      label.append(svg('rect', { x: x - geometry.width / 2, y: y - geometry.height / 2, width: geometry.width, height: geometry.height }));
      for (const [lineIndex, line] of (edgeLabels[index] ?? []).entries()) {
        label.append(svg('text', { x, y: y - geometry.height / 2 + 17 + lineIndex * 16 }, line));
      }
    }
    edgeElements.push({ from: data.rules[edge.from]?.id ?? '', to: data.rules[edge.to]?.id ?? '', path, label });
  });
  // Label backgrounds cover crossing connectors, but never the rule boxes.
  for (const { label } of edgeElements) diagram.append(label);
  data.rules.forEach((rule, index) => {
    const position = graph.node(String(index));
    if (!position || position.x === undefined || position.y === undefined) return;
    const node = svg('a', { class: 'rule-node', tabindex: 0, 'data-rule': rule.id });
    const title = svg('title');
    const left = position.x - position.width / 2, top = position.y - position.height / 2;
    const x = left + 16;
    node.append(title, svg('rect', { x: left, y: top, width: position.width, height: position.height }));
    node.append(svg('text', { x, y: top + 25, class: 'node-type' }, '[Rule · Go function]'));
    const label = labels[index];
    for (const [lineIndex, line] of (label?.name ?? []).entries()) node.append(svg('text', { x, y: top + 52 + lineIndex * 19, class: 'node-name' }, line));
    const descriptionTop = top + 52 + (label?.name.length ?? 0) * 19 + 4;
    for (const [lineIndex, line] of (label?.description ?? []).entries()) node.append(svg('text', { x, y: descriptionTop + lineIndex * 18, class: 'node-description' }, line));
    node.append(svg('line', { x1: x, x2: left + position.width - 16, y1: top + position.height - 43, y2: top + position.height - 43 }));
    const value = svg('text', { x, y: top + position.height - 17, class: 'node-value' });
    node.append(value);
    node.addEventListener('click', event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      select(rule.id, currentCase?.id, true);
    });
    node.addEventListener('keydown', event => {
      if (event.key === ' ') { event.preventDefault(); select(rule.id, currentCase?.id, true); }
    });
    diagram.append(node);
    nodeElements.push({ rule, node, value, title });
  });
}

function render() {
  const previousRule = currentRule;
  const params = new URLSearchParams(location.hash.slice(1));
  query = params.get('q') ?? '';
  search.value = query;
  currentCase = caseMap.get(params.get('case') ?? '') ?? data.cases[0];
  const firstOutput = data.outputs?.[0];
  const defaultRule = firstOutput ? rules.get(producers.get(firstOutput.name) ?? '') : undefined;
  currentRule = rules.get(params.get('rule') ?? '') ?? defaultRule ?? data.rules[0];
  facts = new Map([...Object.entries(currentCase?.inputs ?? {}), ...(currentCase?.trace ?? []).flatMap(trace => Object.entries(trace.facts ?? {}))]);
  traces = new Map((currentCase?.trace ?? []).map(trace => [trace.rule, trace]));
  caseSelect.value = currentCase?.id ?? '';
  ruleSelect.value = currentRule?.id ?? '';
  const canonical = route(currentCase?.id, currentRule?.id);
  if (location.hash !== canonical) history.replaceState(null, '', canonical);
  required('#case-caption', HTMLElement).textContent = currentCase ? `${currentCase.id} / ${currentCase.label}` : 'Ruleset only';
  required('#counts', HTMLElement).textContent = `${data.rules.length} rules · ${data.inputCount} inputs · ${data.outputCount} requested outputs`;
  const succeeded = [...traces.values()].filter(trace => trace.kind === 'succeeded').length;
  const failed = [...traces.values()].filter(trace => trace.kind === 'failed').length;
  const canceled = [...traces.values()].filter(trace => trace.kind === 'canceled').length;
  const notRun = [...traces.values()].filter(trace => trace.kind === 'not_run').length;
  required('#run-summary', HTMLElement).textContent = currentCase ? `${succeeded} succeeded · ${failed} failed · ${canceled} canceled · ${notRun} not run` : 'No evaluation';
  const error = required('#evaluation-error', HTMLElement);
  error.hidden = !currentCase?.error;
  error.textContent = currentCase?.error ? `Evaluation failed. ${currentCase.error}. Values below are diagnostic; the evaluator returned no result.` : '';
  required('#search-results', HTMLElement).textContent = query ? `${data.rules.filter(matches).length} matching rules` : '';
  if (inspector.parentElement !== inspectorHome) inspectorHome.append(inspector);
  renderInspector();
  for (const { rule, node, value, title } of nodeElements) {
    const label = outputLabel(rule);
    node.setAttribute('href', route(currentCase?.id, rule.id));
    node.setAttribute('aria-label', `${rule.id}, ${status(rule)}`);
    node.setAttribute('aria-current', String(rule === currentRule));
    node.dataset.status = traces.get(rule.id)?.kind ?? 'not_evaluated';
    node.classList.toggle('search-match', !!query && matches(rule));
    value.textContent = valueSummary(label);
    title.textContent = `${rule.id}\n${rule.requirement}\n${label}`;
  }
  for (const { from, to, path, label } of edgeElements) {
    const selected = from === currentRule?.id || to === currentRule?.id;
    path.classList.toggle('selected', selected);
    label.classList.toggle('selected', selected);
    path.setAttribute('marker-end', selected ? 'url(#arrow-selected)' : 'url(#arrow)');
  }
  list.replaceChildren();
  const neighbors = new Set<string>();
  if (currentRule) {
    neighbors.add(currentRule.id);
    for (const fact of currentRule.inputs) {
      const producer = producers.get(fact.name);
      if (producer) neighbors.add(producer);
    }
    for (const rule of data.rules) {
      if (rule.inputs.some(fact => producers.get(fact.name) === currentRule?.id)) neighbors.add(rule.id);
    }
  }
  const order = [...data.rules].sort((a, b) => (graph.node(String(data.rules.indexOf(a)))?.y ?? 0) - (graph.node(String(data.rules.indexOf(b)))?.y ?? 0));
  for (const rule of order) {
    if (query ? !matches(rule) : !neighbors.has(rule.id)) continue;
    const row = element('li');
    const link = ruleLink(rule.id, `${rule.id}()`);
    link.setAttribute('aria-current', String(rule === currentRule));
    row.append(element('p', '[Rule · Go function]', 'rule-type'), link, element('p', rule.requirement || 'No requirement supplied.', 'rule-description'), element('p', status(rule)));
    const inputs = element('p', '', 'rule-dependencies');
    inputs.append('Reads: ');
    rule.inputs.forEach((fact, index) => {
      if (index) inputs.append(', ');
      const producer = producers.get(fact.name);
      inputs.append(producer ? ruleLink(producer, `${fact.name} ← ${producer}()`) : element('span', `${fact.name} · Initial input`));
    });
    if (!rule.inputs.length) inputs.append('none');
    row.append(inputs);
    for (const fact of rule.outputs) row.append(element('p', `→ ${fact.name}: ${formatted(fact.name, facts.get(fact.name))}`));
    row.classList.toggle('selected', rule === currentRule);
    list.append(row);
    if (rule === currentRule && mobile.matches) row.append(inspector);
  }
  if (previousRule !== currentRule && !navigation.isFit()) centerSelection();
}

required('#title', HTMLElement).textContent = data.title;
document.title = `${data.title} | Infergo`;
for (const snapshot of data.cases) caseSelect.add(new Option(`${snapshot.id} / ${snapshot.label}`, snapshot.id));
if (!data.cases.length) caseSelect.add(new Option('Ruleset only', ''));
caseSelect.disabled = data.cases.length < 2;
for (const rule of data.rules) ruleSelect.add(new Option(`${rule.id}()`, rule.id));
ruleSelect.disabled = !data.rules.length;
required('#empty', HTMLElement).hidden = !!data.rules.length;
required('.mobile-caption', HTMLElement).hidden = !data.rules.length;
diagram.toggleAttribute('hidden', !data.rules.length);
buildDiagram();
required('#diagram-title', HTMLElement).textContent = `${data.title} · rule dependencies`;
const viewport = required('#diagram-viewport', HTMLDivElement);
viewport.hidden = !data.rules.length;
required('#diagram-fit', HTMLButtonElement).disabled = !data.rules.length;
required('#diagram-actual', HTMLButtonElement).disabled = !data.rules.length;
required('#diagram-zoom-in', HTMLButtonElement).disabled = !data.rules.length;
required('#diagram-zoom-out', HTMLButtonElement).disabled = !data.rules.length;
const navigation = attachDiagramNavigation(viewport, diagram, required('#diagram-fit', HTMLButtonElement), required('#diagram-actual', HTMLButtonElement), required('#diagram-zoom-in', HTMLButtonElement), required('#diagram-zoom-out', HTMLButtonElement));
function centerSelection() {
  const selected = nodeElements.find(({ rule }) => rule === currentRule)?.node;
  navigation.centerOn(selected);
}
search.addEventListener('input', () => {
  query = search.value.toLocaleLowerCase().trim();
  const match = currentRule && matches(currentRule) ? currentRule : data.rules.find(matches);
  history.replaceState(null, '', route(currentCase?.id, match?.id ?? currentRule?.id));
  const position = search.selectionStart;
  render();
  search.setSelectionRange(position, position);
});
required('#back-to-map', HTMLAnchorElement).addEventListener('click', event => {
  event.preventDefault();
  list.querySelector<HTMLAnchorElement>('[aria-current="true"]')?.focus();
});
caseSelect.addEventListener('change', () => select(currentRule?.id, caseSelect.value));
ruleSelect.addEventListener('change', () => select(ruleSelect.value, currentCase?.id, true));
mobile.addEventListener('change', () => { render(); centerSelection(); });
window.addEventListener('popstate', render);
window.addEventListener('hashchange', render);
required('#copy-link', HTMLButtonElement).addEventListener('click', async event => {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) return;
  try {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(location.href);
    button.textContent = 'Link copied';
  } catch {
    button.textContent = 'Copy URL from address bar';
  }
});
render();
required('#viewer', HTMLElement).hidden = false;
centerSelection();
