// Pure functions that derive the dependency graph, fact catalogue, and drop
// verdicts from a Model. No DOM and no I/O, so derive.test.ts runs them under
// node --test. The store calls deriveGraph once per model; regions read the
// result from State.graph and never recompute it.
import type { Fact, Model, Op, Rule } from './protocol';

/**
 * A read of a fact that another rule produces: `from` produces `fact`, `to`
 * reads it. A wire has no source text of its own. A fact with two producers
 * gives two wires into each reader.
 */
export type Wire = { fact: string; from: string; to: string };

/** Stable identity of a wire, for keyed DOM updates and selection comparison. */
export function wireKey(wire: Wire): string {
  return `${wire.from}>${wire.fact}>${wire.to}`;
}

/**
 * Everything the page knows about one fact name. `type` is the input field's
 * type when the fact is an input, otherwise the first producer's, otherwise the
 * first reader's (a dangling read). `requested` means it is an output field.
 */
export type FactInfo = {
  name: string;
  type: string;
  input: boolean;
  requested: boolean;
  producers: string[]; // rule ids, in source order
  readers: string[]; // rule ids, in source order
};

/** The model as a graph. Built by deriveGraph, read-only for everyone. */
export type Graph = {
  rules: ReadonlyMap<string, Rule>; // by id, in source order
  facts: ReadonlyMap<string, FactInfo>; // every fact named anywhere: inputs, outputs, produces, reads
  producers: ReadonlyMap<string, readonly string[]>; // fact -> rules that produce it
  readers: ReadonlyMap<string, readonly string[]>; // fact -> rules that read it
  wires: readonly Wire[]; // in reader source order, then read order
  ancestors: ReadonlyMap<string, ReadonlySet<string>>; // rule -> every rule it transitively reads from. Contains the rule itself only when it sits on a cycle
  order: readonly string[]; // rule ids in dependency order (producers first); rules on a cycle keep source order among themselves
};

/**
 * Whether a held fact can be dropped on a rule. `reads`: the rule already
 * reads it. `produces`: the rule produces it. `unsupported`: structural edits
 * are off for the rule. `cycle`: some producer of the fact already depends on
 * the rule; `path` lists the rules from the target to that producer, each
 * reading a fact from the one before (the same order a cycle Diagnostic uses
 * in `related`), and `wires` are the wires along that path. The held fact
 * would close the loop from the last rule back to the first.
 */
export type Verdict =
  | { ok: true }
  | { ok: false; reason: 'reads' | 'produces' | 'unsupported' }
  | { ok: false; reason: 'cycle'; path: string[]; wires: Wire[] };

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Builds the Graph for a model. Pure; O(rules × wires), which is nothing for hundreds of rules. */
export function deriveGraph(model: Model): Graph {
  const rules = new Map(model.rules.map(rule => [rule.id, rule]));
  const producers = new Map<string, string[]>();
  const readers = new Map<string, string[]>();
  for (const rule of model.rules) {
    for (const fact of rule.produces) push(producers, fact.name, rule.id);
    for (const fact of rule.reads) push(readers, fact.name, rule.id);
  }
  const wires: Wire[] = [];
  for (const rule of model.rules) {
    for (const fact of rule.reads) {
      for (const from of producers.get(fact.name) ?? []) wires.push({ fact: fact.name, from, to: rule.id });
    }
  }

  const facts = new Map<string, FactInfo>();
  const info = (name: string, type: string) => {
    let entry = facts.get(name);
    if (!entry) {
      entry = { name, type, input: false, requested: false, producers: producers.get(name) ?? [], readers: readers.get(name) ?? [] };
      facts.set(name, entry);
    }
    return entry;
  };
  for (const field of model.inputs.fields) {
    const entry = info(field.fact, field.type);
    entry.input = true;
    entry.type = field.type;
  }
  for (const rule of model.rules) for (const fact of rule.produces) info(fact.name, fact.type);
  for (const field of model.outputs.fields) info(field.fact, field.type).requested = true;
  for (const rule of model.rules) for (const fact of rule.reads) info(fact.name, fact.type);

  // Direct upstream rules of each rule, then the transitive closure by search.
  const upstream = new Map<string, Set<string>>(model.rules.map(rule => [rule.id, new Set<string>()]));
  for (const wire of wires) upstream.get(wire.to)?.add(wire.from);
  const ancestors = new Map<string, Set<string>>();
  for (const rule of model.rules) {
    const seen = new Set<string>();
    const stack = [...(upstream.get(rule.id) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(upstream.get(next) ?? []));
    }
    ancestors.set(rule.id, seen);
  }

  return { rules, facts, producers, readers, wires, ancestors, order: dependencyOrder(model.rules, upstream) };
}

// Kahn's algorithm with source order as the tie-break. Rules left over sit on or
// behind a cycle and are appended in source order, so every rule appears once.
function dependencyOrder(rules: readonly Rule[], upstream: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const remaining = new Map(rules.map(rule => [rule.id, new Set([...(upstream.get(rule.id) ?? [])].filter(id => id !== rule.id))]));
  const order: string[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const rule of rules) {
      const waiting = remaining.get(rule.id);
      if (!waiting || waiting.size) continue;
      order.push(rule.id);
      remaining.delete(rule.id);
      for (const other of remaining.values()) other.delete(rule.id);
      progressed = true;
    }
  }
  for (const rule of rules) if (remaining.has(rule.id)) order.push(rule.id);
  return order;
}

/**
 * Shortest chain of wires from rule `from` down to rule `to`, following
 * readers. Returns undefined when `to` does not depend on `from`.
 */
export function wirePath(graph: Graph, from: string, to: string): Wire[] | undefined {
  const outgoing = new Map<string, Wire[]>();
  for (const wire of graph.wires) push(outgoing, wire.from, wire);
  const via = new Map<string, Wire>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current === to && current !== from) break;
    for (const wire of outgoing.get(current) ?? []) {
      if (seen.has(wire.to)) continue;
      seen.add(wire.to);
      via.set(wire.to, wire);
      queue.push(wire.to);
    }
  }
  if (!via.has(to)) return undefined;
  const path: Wire[] = [];
  for (let at = to; at !== from;) {
    const wire = via.get(at)!;
    path.unshift(wire);
    at = wire.from;
  }
  return path;
}

/** Whether `fact` can be dropped on `ruleId`. Checks run in the order the Verdict type lists them. */
export function verdict(graph: Graph, fact: string, ruleId: string): Verdict {
  const rule = graph.rules.get(ruleId);
  if (!rule || rule.unsupported) return { ok: false, reason: 'unsupported' };
  if (rule.reads.some(read => read.name === fact)) return { ok: false, reason: 'reads' };
  if (rule.produces.some(produce => produce.name === fact)) return { ok: false, reason: 'produces' };
  for (const producer of graph.producers.get(fact) ?? []) {
    if (!graph.ancestors.get(producer)?.has(ruleId)) continue;
    const wires = wirePath(graph, ruleId, producer) ?? [];
    return { ok: false, reason: 'cycle', path: [ruleId, ...wires.map(wire => wire.to)], wires };
  }
  return { ok: true };
}

/** Verdicts for every rule, in source order. */
export function verdicts(graph: Graph, fact: string): Map<string, Verdict> {
  return new Map([...graph.rules.keys()].map(id => [id, verdict(graph, fact, id)]));
}

/** One sentence saying why a rule cannot take a fact, for the status line, the sheet, and the picker. */
export function verdictMessage(result: Verdict, fact: string, ruleId: string, graph?: Graph): string {
  if (result.ok) return `${ruleId} can read ${fact}`;
  switch (result.reason) {
    case 'reads': return `${ruleId} already reads ${fact}`;
    case 'produces': return `${ruleId} produces ${fact}`;
    case 'unsupported': return graph?.rules.get(ruleId)?.unsupported ?? `${ruleId} cannot be edited here`;
    case 'cycle': {
      const others = result.path.slice(1);
      return others.length
        ? `It would create a cycle through ${joinNames(others)}`
        : `It would create a cycle with ${ruleId}`;
    }
  }
}

function joinNames(names: readonly string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The add_read operation for a fact dropped on a rule, with the type copied from the catalogue. */
export function addReadOp(graph: Graph, fact: string, ruleId: string): Op {
  return { op: 'add_read', rule: ruleId, fact, type: graph.facts.get(fact)?.type ?? '' };
}

/**
 * The add_rule operation for the inline New rule form. A read places the new
 * rule after that fact's first producer, as the proposal asks; with no read,
 * or for an input, the server picks the end of the first rule file.
 */
export function addRuleOp(graph: Graph, name: string, produces: Fact[], read?: Fact): Op {
  const after = read ? graph.producers.get(read.name)?.[0] : undefined;
  return { op: 'add_rule', name, reads: read ? [read] : [], produces, ...(after ? { after } : {}) };
}

/** The result name the New rule form proposes for a rule name: the name with a lower-case first letter. */
export function suggestedResult(ruleName: string): string {
  return ruleName.charAt(0).toLowerCase() + ruleName.slice(1);
}

/**
 * The id a rule has after a model change that may have renamed it: the same id
 * if it still exists, else the one new rule at the same file and line (a
 * rename keeps the declaration in place). Undefined when it was deleted.
 * The store uses it so a renamed rule stays selected through undo and redo.
 */
export function renamedRule(before: Graph, after: Graph, id: string): string | undefined {
  if (after.rules.has(id)) return id;
  const old = before.rules.get(id);
  if (!old) return undefined;
  const moved = [...after.rules.values()].filter(rule => !before.rules.has(rule.id) && rule.file === old.file && rule.line === old.line);
  return moved.length === 1 ? moved[0]!.id : undefined;
}

/** The rule an operation edits, when it targets exactly one. */
export function opRule(op: Op): string | undefined {
  return 'rule' in op ? op.rule : undefined;
}

/** Whether two operations are the same request. Ops are small, flat JSON, so a JSON comparison suffices. */
export function sameOp(a: Op | undefined, b: Op | undefined): boolean {
  return a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));
}
