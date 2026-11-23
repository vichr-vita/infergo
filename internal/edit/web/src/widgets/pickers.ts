// Pure option lists for the pickers: the sheet's Add read and the Facts
// column's request output. Add read lists every fact that has an origin (an
// input or a producing rule); the ones the rule cannot take stay in the list,
// disabled, with the store's verdict as the reason.
import { verdict, type Graph, type Verdict } from '../derive';

export type ReadOption = {
  fact: string;
  type: string;
  /** "Input", or the producing rules as "← Producer()". */
  origin: string;
  /** Why the rule cannot take it; absent when it can. */
  reason?: string;
};

/** The short reason the picker prints beside a disabled fact. */
export function pickerReason(result: Verdict, graph: Graph, rule: string): string | undefined {
  if (result.ok) return undefined;
  switch (result.reason) {
    case 'reads': return 'Already read';
    case 'produces': return 'Produced by this rule';
    case 'unsupported': return graph.rules.get(rule)?.unsupported ?? 'This rule cannot be edited here';
    case 'cycle': {
      const others = result.path.slice(1);
      if (!others.length) return 'Would create a cycle';
      const names = others.length < 2 ? others.join('') : `${others.slice(0, -1).join(', ')} and ${others.at(-1)}`;
      return `Would create a cycle through ${names}`;
    }
  }
}

/** Where a fact comes from, for the picker and the sheet's rows. */
export function originText(graph: Graph, fact: string): string {
  const info = graph.facts.get(fact);
  if (!info) return 'No producer';
  if (info.producers.length) return info.producers.map(id => `← ${id}()`).join(', ');
  return info.input ? 'Input' : 'No producer';
}

/**
 * The Add read options for `rule`, filtered by `query` (case-insensitive,
 * matching name or type). Choosable facts come first, then names that start
 * with the query before names that only contain it, then alphabetical.
 */
export function readOptions(graph: Graph, rule: string, query: string): ReadOption[] {
  const needle = query.trim().toLocaleLowerCase();
  const rank = (name: string) => (!needle || name.toLocaleLowerCase().startsWith(needle) ? 0 : 1);
  const options: (ReadOption & { rank: number })[] = [];
  for (const info of graph.facts.values()) {
    if (!info.input && !info.producers.length) continue; // a dangling read has nothing to wire
    if (needle && !info.name.toLocaleLowerCase().includes(needle) && !info.type.toLocaleLowerCase().includes(needle)) continue;
    const reason = pickerReason(verdict(graph, info.name, rule), graph, rule);
    options.push({ fact: info.name, type: info.type, origin: originText(graph, info.name), ...(reason ? { reason } : {}), rank: rank(info.name) });
  }
  options.sort((a, b) => Number(!!a.reason) - Number(!!b.reason) || a.rank - b.rank || a.fact.localeCompare(b.fact));
  return options.map(({ rank, ...option }) => { void rank; return option; });
}

/** Derived facts not yet requested, for the Outputs picker, filtered and sorted like readOptions. */
export function requestOptions(graph: Graph, query: string): ReadOption[] {
  const needle = query.trim().toLocaleLowerCase();
  return [...graph.facts.values()]
    .filter(info => info.producers.length && !info.requested)
    .filter(info => !needle || info.name.toLocaleLowerCase().includes(needle) || info.type.toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(!a.name.toLocaleLowerCase().startsWith(needle)) - Number(!b.name.toLocaleLowerCase().startsWith(needle)) || a.name.localeCompare(b.name))
    .map(info => ({ fact: info.name, type: info.type, origin: originText(graph, info.name) }));
}
