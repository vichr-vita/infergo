// Pure checks for names and types typed into the inline forms of the Facts
// column, the rule sheet, and the list view. They catch what the page can
// know before asking the server (empty, not an identifier, already taken), so
// the message appears beside the field at once. The server still has the last
// word, for example on shadowing.
import type { Graph } from '../derive';
import type { Model } from '../protocol';

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

const keywords = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto',
  'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
]);

function identifierProblem(name: string): string | undefined {
  if (!name) return 'Enter a name.';
  if (!identifier.test(name)) return 'Use letters, digits, and underscores, starting with a letter.';
  if (keywords.has(name)) return `${name} is a Go keyword.`;
  return undefined;
}

/** Why `name` cannot be a new fact name, or undefined. `current` is the fact being renamed, which may keep its name. */
export function factNameProblem(name: string, graph: Graph, current?: string): string | undefined {
  const problem = identifierProblem(name);
  if (problem) return problem;
  if (name !== current && graph.facts.has(name)) return `A fact named ${name} already exists.`;
  return undefined;
}

/** Why `name` cannot be a new rule name, or undefined. A rule is an exported Go function. */
export function ruleNameProblem(name: string, graph: Graph, current?: string): string | undefined {
  const problem = identifierProblem(name);
  if (problem) return problem;
  if (!/^[A-Z]/.test(name)) return 'A rule name starts with a capital letter.';
  if (name !== current && graph.rules.has(name)) return `A rule named ${name} already exists.`;
  return undefined;
}

/** Why `type` is not a Go type the forms accept: a name, a pointer, slice, map, or qualified type. */
export function typeProblem(type: string): string | undefined {
  if (!type) return 'Enter a Go type, such as uint64 or *string.';
  if (!/^[\w.*[\]]+$/.test(type) || !/\w/.test(type)) return `${type} is not a Go type this form accepts.`;
  return undefined;
}

/**
 * The requirement text as it will be written: whitespace collapsed, and the
 * rule name put back as the first word if the user removed it, because Go doc
 * comments start with the name they document.
 */
export function withLeadingName(text: string, rule: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === rule || clean.startsWith(`${rule} `)) return clean;
  return clean ? `${rule} ${clean}` : rule;
}

/** True when a requirement says nothing beyond the rule name. */
export function requirementIsEmpty(text: string, rule: string): boolean {
  return withLeadingName(text, rule) === rule;
}

/** Every type spelled in the model, sorted, for the type fields' suggestion lists. */
export function modelTypes(model: Model): string[] {
  const types = new Set<string>();
  for (const field of [...model.inputs.fields, ...model.outputs.fields]) types.add(field.type);
  for (const rule of model.rules) for (const fact of [...rule.reads, ...rule.produces]) types.add(fact.type);
  types.delete('');
  return [...types].sort((a, b) => a.localeCompare(b));
}
