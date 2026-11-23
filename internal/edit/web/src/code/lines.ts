// Small pure helpers that relate the pane's buffer to the file it came from:
// line numbers, where a diagnostic lands, the line a syntax refusal names, the
// function name in the buffer, and where a stub's caret goes. lines.test.ts.
import type { Diagnostic, Rule } from '../protocol';

/** Lines of the leading doc comment in a declaration's text. */
export function docLineCount(source: string): number {
  const lines = source.split('\n');
  const index = lines.findIndex(line => !line.startsWith('//'));
  return index < 0 ? lines.length : index;
}

/** File line of the declaration's first line, the doc comment's first line when there is one. `rule.line` is the func keyword's. */
export function firstFileLine(rule: Pick<Rule, 'line' | 'source'>): number {
  return Math.max(1, rule.line - docLineCount(rule.source));
}

/** The function name the text declares, or undefined when the text has no func line. */
export function declName(text: string): string | undefined {
  return /^func\s+([\p{L}_][\p{L}\p{N}_]*)/mu.exec(text)?.[1];
}

/**
 * The 1-based line of the text that a syntax refusal names. The server says
 * "Line 4, column 3 of Rule does not parse: ..." and the mock "line 4: ...",
 * both counted from the first line of the text that was sent.
 */
export function refusalLine(message: string): number | undefined {
  const match = /\bline (\d+)/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

/** Offset of the first non-blank character of the stub's body line, where typing should start. */
export function stubCaret(text: string): number {
  const lines = text.split('\n');
  const func = lines.findIndex(line => line.startsWith('func '));
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (index > func && func >= 0 && line.trim() && line !== '}') return offset + (line.length - line.trimStart().length);
    offset += line.length + 1;
  }
  return 0;
}

/** A diagnostic placed in the buffer: 0-based offsets in the text, and its 1-based buffer line. */
export type Placed = { from: number; to: number; line: number; diagnostic: Diagnostic };

/**
 * Places a diagnostic whose file line falls inside the declaration. It
 * underlines, in order of preference, the fact it names on that line, the
 * identifier at its column, or the line's text.
 */
export function placeDiagnostic(text: string, firstLine: number, diagnostic: Diagnostic): Placed | undefined {
  if (diagnostic.line === undefined) return undefined;
  const lines = text.split('\n');
  const line = diagnostic.line - firstLine + 1;
  if (line < 1 || line > lines.length) return undefined;
  const content = lines[line - 1]!;
  let start = 0;
  for (let index = 0; index < line - 1; index++) start += lines[index]!.length + 1;
  const word = (at: number) => {
    const match = /^[\p{L}\p{N}_]+/u.exec(content.slice(at));
    return match ? { from: start + at, to: start + at + match[0].length } : undefined;
  };
  let range: { from: number; to: number } | undefined;
  if (diagnostic.fact) {
    const at = new RegExp(`(?<![\\p{L}\\p{N}_])${escape(diagnostic.fact)}(?![\\p{L}\\p{N}_])`, 'u').exec(content)?.index;
    if (at !== undefined) range = word(at);
  }
  if (!range && diagnostic.column && diagnostic.column > 1) range = word(Math.min(diagnostic.column - 1, content.length));
  if (!range) {
    const indent = content.length - content.trimStart().length;
    range = { from: start + indent, to: start + content.trimEnd().length };
  }
  return { ...range, line, diagnostic };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
