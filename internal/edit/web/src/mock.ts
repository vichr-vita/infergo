// An in-memory Api for the dev page (npm run dev:editor) and the unit tests.
// It starts from the bonus fixtures and applies every operation in the
// protocol to its own copy of the model, rewriting each rule's `source` the
// way the server's rewriter would (single-line signatures, gofmt-like
// spacing). It keeps a real undo journal, emits model, history, and check
// events with believable delays, and refuses what the server refuses:
// a cyclic add_read, a duplicate, a missing rule, a stale base, a syntax error.
// Never imported by boot.ts, so it is not in the shipped editor.js.
import type { Api, Connection, EventHandlers, Result } from './api';
import { deriveGraph, verdict, verdictMessage, wirePath, type Wire } from './derive';
import { fixtures } from './fixtures.check';
import type {
  ApplyReply, Change, Check, Contract, ContractField, Diagnostic, Fact, Fix, History, Model, Op, PreviewReply, Receipt, Refusal, Rule,
} from './protocol';

export type MockOptions = {
  /** Delays in milliseconds. Tests pass zeros. Defaults follow the proposal's measurements. */
  latency?: { request?: number; check?: number; values?: number };
  /** `computed` (default) derives diagnostics from the current model. `fixture` sends check.json first, which has one diagnostic of every kind. */
  check?: 'computed' | 'fixture';
  /** `empty` (default) starts with no history. `fixture` starts from history.json, whose entries cannot be undone because the mock has no bytes for them. */
  history?: 'empty' | 'fixture';
};

/** The mock adds a few controls the server has no route for, for the dev page and tests. */
export interface MockApi extends Api {
  /** Replaces a rule's source as if another editor saved the file. Earlier entries for that file stop being undoable. */
  simulateDiskEdit(rule: string, source: string): void;
  /** Sets the connection state the page sees, to exercise the lost-connection display. */
  simulateConnection(state: Connection): void;
  /** The mock's current model, for assertions. */
  current(): Model;
}

type Entry = { receipt: Receipt; before?: Model; after?: Model };
type Outcome = { model: Model; changes: Change[]; label: string } | { refusal: Refusal };

const refuse = (reason: Refusal['reason'], message: string, related?: string[]): Outcome =>
  ({ refusal: { reason, message, ...(related ? { related } : {}) } });

export function mockApi(options: MockOptions = {}): MockApi {
  const latency = { request: 30, check: 265, values: 400, ...options.latency };
  let model: Model = structuredClone(fixtures.model);
  let revision = model.revision;
  let entries: Entry[] = options.history === 'fixture'
    ? fixtures.history.entries.map(receipt => ({ receipt: structuredClone(receipt) }))
    : [];
  let cursor = options.history === 'fixture' ? fixtures.history.cursor : 0;
  let nextId = entries.reduce((max, entry) => Math.max(max, entry.receipt.id), 0) + 1;
  let lastCheck: Check | undefined;
  let valuesOn = false;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let valuesTimer: ReturnType<typeof setTimeout> | undefined;
  const subscribers = new Set<EventHandlers>();
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const emit = <K extends keyof EventHandlers>(name: K, data: Parameters<EventHandlers[K]>[0]) => {
    for (const handlers of subscribers) (handlers[name] as (payload: typeof data) => void)(structuredClone(data));
  };
  const history = (): History => ({ entries: entries.map(entry => entry.receipt), cursor });

  function scheduleCheck(first = false) {
    clearTimeout(checkTimer);
    clearTimeout(valuesTimer);
    const at = model.revision;
    checkTimer = setTimeout(() => {
      const check = first && options.check === 'fixture'
        ? { ...fixtures.check, revision: at }
        : computeCheck(model, lastCheck);
      lastCheck = check;
      emit('check', check);
      if (valuesOn && check.ok) valuesTimer = setTimeout(() => emit('values', { ...fixtures.values, revision: at }), latency.values);
    }, latency.check);
  }

  function publish() {
    emit('model', model);
    emit('history', history());
    scheduleCheck();
  }

  function record(next: Model, changes: Change[], label: string, source: Receipt['source']): Receipt {
    const receipt: Receipt = { id: nextId++, label, source, files: receiptFiles(changes), time: new Date().toISOString() };
    if (source === 'disk') {
      const touched = new Set(changes.map(change => change.file));
      for (const entry of entries.slice(0, cursor)) {
        if (entry.receipt.files.some(file => touched.has(file.path))) entry.receipt.undoable = false;
      }
    }
    entries = [...entries.slice(0, cursor), { receipt, before: model, after: next }];
    cursor = entries.length;
    model = { ...next, revision: ++revision };
    entries[cursor - 1]!.after = model;
    publish();
    return receipt;
  }

  async function respond<T>(value: () => Result<T>): Promise<Result<T>> {
    await wait(latency.request);
    return value();
  }

  function step(direction: 'undo' | 'redo'): Result<ApplyReply> {
    const entry = direction === 'undo' ? entries[cursor - 1] : entries[cursor];
    if (!entry) return { kind: 'refused', refusal: { reason: 'not_found', message: direction === 'undo' ? 'Nothing to undo' : 'Nothing to redo' } };
    if (entry.receipt.undoable === false || !entry.before || !entry.after) {
      return { kind: 'refused', refusal: { reason: 'conflict', message: `${entry.receipt.files.map(file => file.path).join(', ')} changed outside the editor after this edit. Use your IDE or git to go back further.` } };
    }
    model = { ...structuredClone(direction === 'undo' ? entry.before : entry.after), revision: ++revision };
    cursor += direction === 'undo' ? -1 : 1;
    publish();
    return { kind: 'ok', value: { revision, receipt: entry.receipt } };
  }

  return {
    kind: 'mock',
    model: () => respond(() => ({ kind: 'ok', value: structuredClone(model) })),
    preview: op => respond<PreviewReply>(() => {
      const outcome = applyOp(model, op);
      return 'refusal' in outcome ? { kind: 'refused', refusal: outcome.refusal } : { kind: 'ok', value: { changes: outcome.changes } };
    }),
    apply: op => respond<ApplyReply>(() => {
      const outcome = applyOp(model, op);
      if ('refusal' in outcome) return { kind: 'refused', refusal: outcome.refusal };
      const receipt = record(outcome.model, outcome.changes, outcome.label, 'editor');
      return { kind: 'ok', value: { revision, receipt } };
    }),
    undo: () => respond(() => step('undo')),
    redo: () => respond(() => step('redo')),
    setValues: enabled => respond(() => {
      valuesOn = enabled;
      if (enabled && lastCheck?.ok) emit('values', { ...fixtures.values, revision: model.revision });
      return { kind: 'ok', value: undefined };
    }),
    subscribe(handlers) {
      subscribers.add(handlers);
      setTimeout(() => {
        if (!subscribers.has(handlers)) return;
        handlers.connection('open');
        handlers.model(structuredClone(model));
        handlers.history(structuredClone(history()));
        if (lastCheck) handlers.check(structuredClone(lastCheck));
        else scheduleCheck(true);
      }, 0);
      return () => { subscribers.delete(handlers); };
    },
    simulateDiskEdit(rule, source) {
      const outcome = applyOp(model, { op: 'replace_source', rule, text: source, base: model.rules.find(r => r.id === rule)?.sourceHash ?? '' });
      if ('refusal' in outcome) throw new Error(outcome.refusal.message);
      const files = [...new Set(outcome.changes.map(change => change.file))].join(', ');
      record(outcome.model, outcome.changes, `Changed ${files} in another editor`, 'disk');
    },
    simulateConnection(state) {
      for (const handlers of subscribers) handlers.connection(state);
    },
    current: () => structuredClone(model),
  };
}

// ---------------------------------------------------------------------------
// Operations. Each returns a new model, one Change per touched declaration,
// and the receipt sentence, or a Refusal. The input model is not mutated.

export function applyOp(current: Model, op: Op): Outcome {
  const model: Model = structuredClone(current);
  const graph = deriveGraph(current);
  const changes: Change[] = [];
  const rule = 'rule' in op && op.op !== 'rename_fact' ? model.rules.find(r => r.id === op.rule) : undefined;
  if ('rule' in op && op.op !== 'rename_fact' && !rule) return refuse('not_found', `No rule named ${op.rule}`);

  // Rewrites one rule from an edited declaration and records the Change.
  const rewrite = (target: Rule, edit: (decl: Decl) => void): Refusal | undefined => {
    const decl = parseDecl(target.source);
    if (typeof decl === 'string') return { reason: 'syntax_error', message: `${target.file}: ${decl}` };
    edit(decl);
    const before = target.source;
    setSource(model, target, renderDecl(decl));
    changes.push({ file: target.file, rule: target.id, before, after: target.source });
    return undefined;
  };
  const done = (label: string): Outcome => ({ model, changes, label });
  const fail = (refusal: Refusal | undefined, label: string) => refusal ? { refusal } : done(label);
  const structural = (target: Rule) => target.unsupported ? refuse('unsupported', `${target.id}: ${target.unsupported}`) : undefined;

  switch (op.op) {
    case 'add_read': {
      const target = rule!;
      const result = verdict(graph, op.fact, target.id);
      if (!result.ok) {
        const message = verdictMessage(result, op.fact, target.id, graph);
        if (result.reason === 'cycle') return refuse('cycle', `${message}. Nothing was written.`, result.path);
        if (result.reason === 'unsupported') return refuse('unsupported', message);
        return refuse('exists', message);
      }
      return fail(rewrite(target, decl => decl.params.push({ name: op.fact, type: op.type })), `Wired ${op.fact} into ${target.id}`);
    }
    case 'remove_read': {
      const target = rule!;
      if (!target.reads.some(read => read.name === op.fact)) return refuse('not_found', `${target.id} does not read ${op.fact}`);
      const uses = countUses(target.source, op.fact) - 1;
      const outcome = fail(rewrite(target, decl => { decl.params = decl.params.filter(field => field.name !== op.fact); }), `Unwired ${op.fact} from ${target.id}`);
      if ('label' in outcome && uses > 0) outcome.label += `. ${uses} ${uses === 1 ? 'use remains' : 'uses remain'} in the body`;
      return outcome;
    }
    case 'add_rule': {
      if (!/^[A-Z]\w*$/.test(op.name)) return refuse('unsupported', `${op.name} is not an exported Go name`);
      if (graph.rules.has(op.name)) return refuse('exists', `A rule named ${op.name} already exists`);
      const clash = op.produces.find(fact => graph.facts.has(fact.name) && (graph.facts.get(fact.name)!.input || graph.producers.has(fact.name)));
      if (clash) return refuse('exists', `${clash.name} already has a producer`);
      const after = op.after ? model.rules.find(r => r.id === op.after) : undefined;
      const file = after?.file ?? model.rules[0]?.file ?? model.files[0]?.path ?? 'rules.go';
      const source = stubSource(op.name, op.reads, op.produces);
      const anchor = after ?? [...model.rules].reverse().find(r => r.file === file);
      const start = anchor ? blockEnd(anchor) + 2 : 1;
      const lines = source.split('\n').length;
      shiftLines(model, file, start, lines + 1);
      const created: Rule = {
        id: op.name, file, line: start + 1, requirement: `${op.name} TODO: state the requirement.`, source, sourceHash: hash(source),
        reads: op.reads, produces: op.produces, usesContext: false, returnsError: true, stub: true,
      };
      model.rules.splice(anchor ? model.rules.indexOf(anchor) + 1 : model.rules.length, 0, created);
      changes.push({ file, rule: op.name, before: '', after: source });
      return done(`Added rule ${op.name}`);
    }
    case 'delete_rule': {
      const target = rule!;
      const lines = target.source.split('\n').length;
      model.rules = model.rules.filter(r => r !== target);
      shiftLines(model, target.file, blockStart(target), -(lines + 1));
      changes.push({ file: target.file, rule: target.id, before: target.source, after: '' });
      return done(`Deleted rule ${target.id}`);
    }
    case 'rename_rule': {
      const target = rule!;
      if (!/^[A-Z]\w*$/.test(op.to)) return refuse('unsupported', `${op.to} is not an exported Go name`);
      if (graph.rules.has(op.to)) return refuse('exists', `A rule named ${op.to} already exists`);
      const before = target.source;
      const refusal = rewrite(target, decl => {
        decl.name = op.to;
        if (decl.doc[0]?.startsWith(`// ${target.id} `)) decl.doc[0] = `// ${op.to} ${decl.doc[0].slice(target.id.length + 4)}`;
      });
      if (refusal) return { refusal };
      changes[0] = { file: target.file, rule: op.to, before, after: target.source };
      target.id = op.to;
      target.requirement = requirementOf(target.source);
      return done(`Renamed rule ${op.rule} to ${op.to}`);
    }
    case 'rename_fact': {
      if (!graph.facts.has(op.fact)) return refuse('not_found', `No fact named ${op.fact}`);
      if (!/^[A-Za-z_]\w*$/.test(op.to)) return refuse('unsupported', `${op.to} is not a Go identifier`);
      if (graph.facts.has(op.to)) return refuse('exists', `A fact named ${op.to} already exists`);
      const only = op.rule ? model.rules.find(r => r.id === op.rule) : undefined;
      if (op.rule && !only) return refuse('not_found', `No rule named ${op.rule}`);
      const targets = only ? [only] : model.rules.filter(r => [...r.reads, ...r.produces].some(fact => fact.name === op.fact));
      for (const target of targets) {
        const decl = parseDecl(target.source);
        if (typeof decl === 'string') return refuse('syntax_error', `${target.file}: ${decl}`);
        if (new RegExp(`\\b${op.to}\\b`).test(decl.body)) {
          return refuse('shadow', `${target.id} already uses the name ${op.to}`, [target.id]);
        }
        const before = target.source;
        for (const field of [...decl.params, ...decl.results]) if (field.name === op.fact) field.name = op.to;
        decl.body = decl.body.replace(new RegExp(`\\b${op.fact}\\b`, 'g'), op.to);
        setSource(model, target, renderDecl(decl));
        changes.push({ file: target.file, rule: target.id, before, after: target.source });
      }
      if (!only) {
        for (const contract of [model.inputs, model.outputs]) {
          if (!contract.fields.some(field => field.fact === op.fact)) continue;
          const before = contractSource(contract);
          for (const field of contract.fields) if (field.fact === op.fact) field.fact = op.to;
          changes.push({ file: contract.file, before, after: contractSource(contract) });
        }
      }
      return done(`Renamed fact ${op.fact} to ${op.to}`);
    }
    case 'set_requirement': {
      const target = rule!;
      const text = op.text.replace(/\s+/g, ' ').trim();
      if (!text) return refuse('unsupported', 'The requirement cannot be empty');
      const refusal = rewrite(target, decl => { decl.doc = wrapComment(text); });
      if (refusal) return { refusal };
      return done(`Reworded the requirement of ${target.id}`);
    }
    case 'add_produce': {
      const target = rule!;
      const blocked = structural(target);
      if (blocked) return blocked;
      if (target.produces.some(fact => fact.name === op.fact)) return refuse('exists', `${target.id} already produces ${op.fact}`);
      return fail(rewrite(target, decl => {
        const error = decl.results.at(-1)?.type === 'error' ? decl.results.pop()! : undefined;
        decl.results = decl.results.filter(field => field.name);
        decl.results.push({ name: op.fact, type: op.type });
        if (error) decl.results.push({ name: error.name ?? 'err', type: 'error' });
      }), `Added result ${op.fact} to ${target.id}`);
    }
    case 'remove_produce': {
      const target = rule!;
      if (!target.produces.some(fact => fact.name === op.fact)) return refuse('not_found', `${target.id} does not produce ${op.fact}`);
      return fail(rewrite(target, decl => { decl.results = decl.results.filter(field => field.name !== op.fact); }), `Removed result ${op.fact} from ${target.id}`);
    }
    case 'set_type': {
      const target = rule!;
      if (![...target.reads, ...target.produces].some(fact => fact.name === op.fact)) return refuse('not_found', `${target.id} has no ${op.fact}`);
      return fail(rewrite(target, decl => {
        for (const field of [...decl.params, ...decl.results]) if (field.name === op.fact) field.type = op.type;
      }), `Changed ${op.fact} in ${target.id} to ${op.type}`);
    }
    case 'add_input':
    case 'set_requested': {
      const input = op.op === 'add_input';
      const contract = input ? model.inputs : model.outputs;
      if (!contract.editable) return refuse('unsupported', `${contract.type} is declared in another package`);
      const present = contract.fields.some(field => field.fact === op.fact);
      if (!input && !op.requested) {
        if (!present) return refuse('not_found', `${op.fact} is not requested`);
        return removeField(contract, op.fact, changes) ?? done(`Stopped requesting ${op.fact}`);
      }
      if (present) return refuse('exists', `${op.fact} is already ${input ? 'an input' : 'requested'}`);
      if (input && graph.producers.has(op.fact)) return refuse('exists', `${op.fact} already has a producer`);
      const type = input ? op.type : graph.facts.get(op.fact)?.type;
      if (!type) return refuse('not_found', `No fact named ${op.fact}`);
      const before = contractSource(contract);
      const line = Math.max(0, ...contract.fields.map(field => field.line)) + 1;
      contract.fields.push({ field: exported(op.fact), fact: op.fact, type, line });
      changes.push({ file: contract.file, before, after: contractSource(contract) });
      return done(input ? `Added input ${op.fact}` : `Requested ${op.fact}`);
    }
    case 'remove_input': {
      if (!model.inputs.fields.some(field => field.fact === op.fact)) return refuse('not_found', `${op.fact} is not an input`);
      return removeField(model.inputs, op.fact, changes) ?? done(`Removed input ${op.fact}`);
    }
    case 'replace_source': {
      const target = rule!;
      if (op.base !== target.sourceHash) return refuse('stale_base', `${target.id} changed on disk since the pane loaded it`);
      const decl = parseDecl(op.text);
      if (typeof decl === 'string') return refuse('syntax_error', decl);
      if (decl.name !== target.id && graph.rules.has(decl.name)) return refuse('exists', `A rule named ${decl.name} already exists`);
      const before = target.source;
      const text = op.text.replace(/\s+$/, '');
      setSource(model, target, text);
      target.id = decl.name;
      changes.push({ file: target.file, rule: target.id, before, after: text });
      return done(`Edited ${target.id}`);
    }
  }
}

// Removes a contract field and records the Change. Returns a refusal, or undefined on success.
function removeField(contract: Contract, fact: string, changes: Change[]): Outcome | undefined {
  if (!contract.editable) return refuse('unsupported', `${contract.type} is declared in another package`);
  const before = contractSource(contract);
  contract.fields = contract.fields.filter(field => field.fact !== fact);
  changes.push({ file: contract.file, before, after: contractSource(contract) });
  return undefined;
}

// ---------------------------------------------------------------------------
// Declarations as text. A deliberately small reader for the rule shapes in the
// fixtures: doc comment lines, `func Name(params) results {`, and a body.

/** A parameter or result: `name type`, or a bare type when unnamed. */
type Field = { name?: string; type: string };
type Decl = { doc: string[]; name: string; params: Field[]; results: Field[]; body: string };

const opening = '([{';
const closing = ')]}';

// Index of the bracket that closes the one at `start`, skipping strings, runes,
// and comments. -1 when unbalanced.
function matchClose(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === '\'' || c === '`') {
      const end = c === '`' ? text.indexOf('`', i + 1) : findQuoteEnd(text, i);
      if (end < 0) return -1;
      i = end;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end < 0) return -1;
      i = end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (opening.includes(c)) depth++;
    else if (closing.includes(c)) {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function findQuoteEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i;
    else if (text[i] === '\n') return -1;
  }
  return -1;
}

// Splits on commas at bracket depth zero.
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (opening.includes(c)) depth++;
    else if (closing.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  parts.push(text.slice(from));
  return parts.map(part => part.trim()).filter(Boolean);
}

// Go's grouping rule: if any item is `name type`, bare items are names that
// take the type of the next typed item.
function fields(items: string[]): Field[] {
  const parsed: Field[] = items.map(item => {
    const match = /^([A-Za-z_]\w*)\s+(\S[\s\S]*)$/.exec(item);
    return match ? { name: match[1]!, type: match[2]!.replace(/\s+/g, ' ') } : { type: item };
  });
  if (!parsed.some(field => field.name)) return parsed;
  let type = '';
  for (let i = parsed.length - 1; i >= 0; i--) {
    const field = parsed[i]!;
    if (field.name) type = field.type;
    else parsed[i] = { name: field.type, type };
  }
  return parsed;
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Parses a rule declaration, or returns a message naming the line of the first problem. */
export function parseDecl(source: string): Decl | string {
  const lines = source.split('\n');
  const doc: string[] = [];
  while (lines.length && lines[0]!.startsWith('//')) doc.push(lines.shift()!);
  const offset = doc.length;
  const rest = lines.join('\n');
  const head = /^func\s+([A-Za-z_]\w*)\s*\(/.exec(rest);
  if (!head) return `line ${offset + 1}: expected a func declaration after the doc comment`;
  const paramsOpen = head[0].length - 1;
  const paramsClose = matchClose(rest, paramsOpen);
  if (paramsClose < 0) return `line ${offset + 1}: the parameter list is not closed`;
  let bodyOpen = -1;
  for (let i = paramsClose + 1, depth = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '{' && depth === 0) { bodyOpen = i; break; }
  }
  if (bodyOpen < 0) return `line ${offset + lineAt(rest, paramsClose)}: missing function body`;
  const bodyClose = matchClose(rest, bodyOpen);
  if (bodyClose < 0) return `line ${offset + lineAt(rest, rest.length)}: the function body is not closed`;
  if (rest.slice(bodyClose + 1).trim()) return `line ${offset + lineAt(rest, bodyClose + 1)}: unexpected text after the function body`;
  let resultsText = rest.slice(paramsClose + 1, bodyOpen).trim();
  if (resultsText.startsWith('(')) {
    const end = matchClose(resultsText, 0);
    if (end !== resultsText.length - 1) return `line ${offset + lineAt(rest, paramsClose)}: malformed result list`;
    resultsText = resultsText.slice(1, -1);
    return { doc, name: head[1]!, params: fields(splitTop(rest.slice(paramsOpen + 1, paramsClose))), results: fields(splitTop(resultsText)), body: rest.slice(bodyOpen, bodyClose + 1) };
  }
  return {
    doc, name: head[1]!, params: fields(splitTop(rest.slice(paramsOpen + 1, paramsClose))),
    results: resultsText ? [{ type: resultsText }] : [], body: rest.slice(bodyOpen, bodyClose + 1),
  };
}

function renderField(field: Field): string {
  return field.name ? `${field.name} ${field.type}` : field.type;
}

/** Prints a declaration with a one-line signature, as gofmt leaves a short one. */
export function renderDecl(decl: Decl): string {
  const results = decl.results.length === 0 ? ''
    : decl.results.length === 1 && !decl.results[0]!.name ? ` ${decl.results[0]!.type}`
      : ` (${decl.results.map(renderField).join(', ')})`;
  return [...decl.doc, `func ${decl.name}(${decl.params.map(renderField).join(', ')})${results} ${decl.body}`].join('\n');
}

function requirementOf(source: string): string {
  const doc: string[] = [];
  for (const line of source.split('\n')) {
    if (!line.startsWith('//')) break;
    doc.push(line.replace(/^\/\/ ?/, ''));
  }
  return doc.join(' ').replace(/\s+/g, ' ').trim();
}

/** Wraps text into `// ` lines of at most 80 columns. */
export function wrapComment(text: string): string[] {
  const lines: string[] = [];
  let line = '//';
  for (const word of text.split(' ')) {
    if (line !== '//' && line.length + 1 + word.length > 80) { lines.push(line); line = '//'; }
    line += ` ${word}`;
  }
  lines.push(line);
  return lines;
}

// Updates a rule from new source: parse fields, hash, requirement, line shifts.
function setSource(model: Model, rule: Rule, source: string) {
  const delta = source.split('\n').length - rule.source.split('\n').length;
  const docDelta = source.split('\n').findIndex(line => !line.startsWith('//')) - rule.source.split('\n').findIndex(line => !line.startsWith('//'));
  if (delta) shiftLines(model, rule.file, blockStart(rule) + rule.source.split('\n').length, delta);
  rule.line += docDelta;
  rule.source = source;
  rule.sourceHash = hash(source);
  rule.requirement = requirementOf(source);
  const decl = parseDecl(source);
  if (typeof decl === 'string') return;
  rule.usesContext = decl.params[0]?.type === 'context.Context';
  rule.returnsError = decl.results.at(-1)?.type === 'error';
  const params = decl.params.slice(rule.usesContext ? 1 : 0);
  const results = decl.results.slice(0, rule.returnsError ? -1 : undefined);
  rule.reads = params.map(field => ({ name: field.name ?? '', type: field.type }));
  rule.produces = results.filter(field => field.name).map(field => ({ name: field.name!, type: field.type }));
  rule.stub = /errors\.New\("\w+ is not implemented"\)/.test(decl.body);
  const unnamed = params.some(field => !field.name) ? 'every parameter needs a name, which is the fact it reads'
    : results.some(field => !field.name) ? 'every result needs a name, which is the fact it produces' : undefined;
  if (unnamed) rule.unsupported = unnamed;
  else delete rule.unsupported;
}

const blockStart = (rule: Rule) => rule.line - rule.source.split('\n').findIndex(line => !line.startsWith('//'));
const blockEnd = (rule: Rule) => blockStart(rule) + rule.source.split('\n').length - 1;

// Moves every rule in `file` that starts at or after `from` by `delta` lines.
function shiftLines(model: Model, file: string, from: number, delta: number) {
  for (const rule of model.rules) if (rule.file === file && blockStart(rule) >= from) rule.line += delta;
}

function stubSource(name: string, reads: Fact[], produces: Fact[]): string {
  const results = [...produces.map(fact => `${fact.name} ${fact.type}`), 'err error'].join(', ');
  const returned = [...produces.map(fact => fact.name), `errors.New("${name} is not implemented")`].join(', ');
  return [
    `// ${name} TODO: state the requirement.`,
    `func ${name}(${reads.map(fact => `${fact.name} ${fact.type}`).join(', ')}) (${results}) {`,
    `\treturn ${returned}`,
    '}',
  ].join('\n');
}

function contractSource(contract: Contract): string {
  const width = (pick: (field: ContractField) => string) => Math.max(0, ...contract.fields.map(field => pick(field).length));
  const name = width(field => field.field);
  const type = width(field => field.type);
  const rows = contract.fields.map(field => `\t${field.field.padEnd(name)} ${field.type.padEnd(type)} \`fact:"${field.fact}"\``);
  return [`type ${contract.type} struct {`, ...rows, '}'].join('\n');
}

const exported = (fact: string) => fact.charAt(0).toUpperCase() + fact.slice(1);

function countUses(source: string, name: string): number {
  const decl = parseDecl(source);
  const text = typeof decl === 'string' ? source : decl.body;
  return (text.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length + 1;
}

// Not cryptographic: the mock only needs a value that changes with the text.
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Added and removed line counts per file, from a line-level longest common subsequence. */
function receiptFiles(changes: Change[]): Receipt['files'] {
  const files = new Map<string, { added: number; removed: number }>();
  for (const change of changes) {
    const before = change.before ? change.before.split('\n') : [];
    const after = change.after ? change.after.split('\n') : [];
    const common = lcs(before, after);
    const entry = files.get(change.file) ?? { added: 0, removed: 0 };
    entry.added += after.length - common;
    entry.removed += before.length - common;
    files.set(change.file, entry);
  }
  return [...files].map(([path, counts]) => ({ path, ...counts }));
}

function lcs(a: string[], b: string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const line of a) {
    const row = [0];
    for (let j = 0; j < b.length; j++) row.push(line === b[j] ? previous[j]! + 1 : Math.max(previous[j + 1]!, row[j]!));
    previous = row;
  }
  return previous[b.length]!;
}

// ---------------------------------------------------------------------------
// Diagnostics computed from the model, a believable subset of the compiler's.

function computeCheck(model: Model, previous: Check | undefined): Check {
  const graph = deriveGraph(model);
  const diagnostics: Diagnostic[] = [];
  const at = (rule: Rule) => ({ file: rule.file, line: rule.line, column: 1 });
  const known = [...graph.facts.values()].filter(fact => fact.input || fact.producers.length).map(fact => fact.name);

  for (const rule of model.rules) {
    for (const read of rule.reads) {
      const fact = graph.facts.get(read.name)!;
      if (!fact.input && !fact.producers.length) {
        const suggestion = closest(read.name, known);
        const fixes: Fix[] = [];
        if (suggestion) fixes.push({ label: `Rename to ${suggestion}`, op: { op: 'rename_fact', fact: read.name, to: suggestion } });
        fixes.push({ label: `Add input ${read.name}`, op: { op: 'add_input', fact: read.name, type: read.type } });
        fixes.push({ label: `Create a rule that produces ${read.name}`, op: { op: 'add_rule', name: exported(read.name), reads: [], produces: [read], after: rule.id } });
        diagnostics.push({
          ...at(rule), severity: 'error', kind: 'missing_producer', rule: rule.id, fact: read.name, fixes,
          message: `rule ${rule.id} reads fact "${read.name}", which no input or rule produces${suggestion ? `; did you mean "${suggestion}"?` : ''}`,
        });
        continue;
      }
      const source = fact.input ? model.inputs.fields.find(field => field.fact === read.name)?.type
        : graph.rules.get(fact.producers[0]!)?.produces.find(produce => produce.name === read.name)?.type;
      if (source !== undefined && source !== read.type) {
        diagnostics.push({
          ...at(rule), severity: 'error', kind: 'type_mismatch', rule: rule.id, fact: read.name,
          ...(fact.producers[0] ? { related: [fact.producers[0]] } : {}),
          message: `rule ${rule.id} reads fact "${read.name}" as ${read.type}, but ${fact.producers[0] ?? 'the input'} produces ${source}`,
          fixes: [{ label: `Use ${source} in ${rule.id}`, op: { op: 'set_type', rule: rule.id, fact: read.name, type: source } }],
        });
      }
    }
  }
  for (const fact of graph.facts.values()) {
    if (fact.producers.length < 2) continue;
    const [first, ...others] = fact.producers;
    for (const other of others) {
      diagnostics.push({
        ...at(graph.rules.get(other)!), severity: 'error', kind: 'duplicate_producer', rule: other, fact: fact.name, related: [first!],
        message: `fact "${fact.name}" has multiple producers`,
        fixes: [{ label: `Rename the result in ${other}`, op: { op: 'rename_fact', rule: other, fact: fact.name, to: `${fact.name}2` } }],
      });
    }
  }
  const reported = new Set<string>();
  for (const rule of model.rules) {
    if (!graph.ancestors.get(rule.id)?.has(rule.id)) continue;
    const back = graph.wires.find(wire => wire.to === rule.id && (wire.from === rule.id || graph.ancestors.get(wire.from)?.has(rule.id)));
    if (!back) continue;
    const loop: Wire[] = [...(back.from === rule.id ? [] : wirePath(graph, rule.id, back.from) ?? []), back];
    const members = [rule.id, ...loop.slice(0, -1).map(wire => wire.to)];
    const key = [...members].sort().join();
    if (reported.has(key)) continue;
    reported.add(key);
    diagnostics.push({
      ...at(rule), severity: 'error', kind: 'cycle', rule: rule.id, fact: back.fact, related: members,
      message: `rules depend on each other: ${[...members, rule.id].join(', ')}`,
      fixes: loop.map(wire => ({ label: `Remove ${wire.fact} from ${wire.to}`, op: { op: 'remove_read', rule: wire.to, fact: wire.fact } })),
    });
  }
  for (const rule of model.rules) {
    if (!rule.unsupported) continue;
    diagnostics.push({ ...at(rule), severity: 'error', kind: 'signature', rule: rule.id, message: `rule ${rule.id}: ${rule.unsupported}`, fixes: [] });
  }

  // Rules no requested output needs, and inputs only they read.
  const needed = new Set<string>();
  for (const field of model.outputs.fields) {
    for (const producer of graph.producers.get(field.fact) ?? []) {
      needed.add(producer);
      for (const ancestor of graph.ancestors.get(producer) ?? []) needed.add(ancestor);
    }
  }
  const pruned = model.rules.filter(rule => !needed.has(rule.id)).map(rule => rule.id);
  for (const id of pruned) {
    const rule = graph.rules.get(id)!;
    const output = rule.produces[0];
    diagnostics.push({
      ...at(rule), severity: 'warning', kind: 'unused_rule', rule: id, ...(output ? { fact: output.name } : {}),
      message: `rule ${id} is not needed by any requested output`,
      fixes: [
        ...(output ? [{ label: `Request ${output.name} as an output`, op: { op: 'set_requested', fact: output.name, requested: true } } satisfies Fix] : []),
        { label: `Delete ${id}`, op: { op: 'delete_rule', rule: id } },
      ],
    });
  }
  for (const field of model.inputs.fields) {
    if ((graph.readers.get(field.fact) ?? []).some(reader => needed.has(reader))) continue;
    diagnostics.push({
      file: model.inputs.file, line: field.line, column: 2, severity: 'warning', kind: 'unused_input', fact: field.fact,
      message: `input fact "${field.fact}" is not used by any requested output`,
      fixes: [{ label: `Remove input ${field.fact}`, op: { op: 'remove_input', fact: field.fact } }],
    });
  }

  const ok = !diagnostics.some(diagnostic => diagnostic.severity === 'error');
  const evaluator: Check['evaluator'] = !ok ? 'kept' : previous && previous.revision !== model.revision ? 'updated' : 'current';
  return { revision: model.revision, ok, diagnostics, pruned, evaluator };
}

// The nearest known name within two edits, as the compiler's "did you mean".
function closest(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    previous = row;
  }
  return previous[b.length]!;
}

