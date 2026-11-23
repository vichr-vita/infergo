// Token-granular text diff for the code pane. The preview marks what an
// operation inserts and removes in a declaration, and an outside change is
// applied to the buffer as the smallest change set, so the caret and the
// buffer's undo history survive it. Pure, no DOM: diff.test.ts runs it.

/** One run of a diff. `equal` and `insert` text is in the new text; `delete` text is from the old. */
export type Part = { kind: 'equal' | 'insert' | 'delete'; text: string };

/**
 * Splits text into identifiers and numbers, runs of spaces and tabs, line
 * breaks, and single other characters, so adding one parameter differs by
 * exactly that parameter and its comma.
 */
export function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+|[ \t]+|\n|[^]/gu) ?? [];
}

/**
 * Diffs two texts by token. Common leading tokens are matched first, then
 * common trailing ones, then a longest common subsequence covers the middle.
 * Adjacent runs of one kind are merged, and a run of spaces sitting alone
 * between two changes joins them, so a change reads as one span.
 */
export function diff(before: string, after: string): Part[] {
  const a = tokenize(before);
  const b = tokenize(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const parts: Part[] = [];
  const push = (kind: Part['kind'], text: string) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  push('equal', a.slice(0, start).join(''));
  for (const part of middle(a.slice(start, endA), b.slice(start, endB))) push(part.kind, part.text);
  push('equal', a.slice(endA).join(''));
  return joinIslands(parts);
}

// Longest common subsequence over the tokens that differ, walked from the
// front so that ties keep the earliest match and insertions land after it.
function middle(a: string[], b: string[]): Part[] {
  const n = a.length;
  const m = b.length;
  if (!n) return b.length ? [{ kind: 'insert', text: b.join('') }] : [];
  if (!m) return [{ kind: 'delete', text: a.join('') }];
  // suffix[i][j] = LCS length of a[i..] and b[j..], stored row by row.
  const width = m + 1;
  const suffix = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      suffix[i * width + j] = a[i] === b[j]
        ? suffix[(i + 1) * width + j + 1]! + 1
        : Math.max(suffix[(i + 1) * width + j]!, suffix[i * width + j + 1]!);
    }
  }
  const parts: Part[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { parts.push({ kind: 'equal', text: a[i]! }); i++; j++; }
    else if (suffix[(i + 1) * width + j]! >= suffix[i * width + j + 1]!) parts.push({ kind: 'delete', text: a[i++]! });
    else parts.push({ kind: 'insert', text: b[j++]! });
  }
  while (i < n) parts.push({ kind: 'delete', text: a[i++]! });
  while (j < m) parts.push({ kind: 'insert', text: b[j++]! });
  return parts;
}

// Folds an equal run of blanks between two changes into them, then merges
// neighbours of the same kind.
function joinIslands(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const before = out.at(-1);
    const next = parts[index + 1];
    if (part.kind === 'equal' && /^[ \t]+$/.test(part.text) && before && before.kind !== 'equal' && next && next.kind !== 'equal') {
      // Show the blank as removed and re-inserted, so both spans read whole.
      out.push({ kind: 'delete', text: part.text }, { kind: 'insert', text: part.text });
    } else out.push({ ...part });
  }
  const merged: Part[] = [];
  for (const part of out) {
    const last = merged.at(-1);
    if (last?.kind === part.kind) last.text += part.text;
    // Keep deletions before insertions in a mixed change, so it reads as "this became that".
    else if (last?.kind === 'insert' && part.kind === 'delete' && merged.at(-2)?.kind === 'delete') merged.at(-2)!.text += part.text;
    else merged.push({ ...part });
  }
  return merged;
}

/** What the preview draws over the new text: inserted ranges and removed text anchored at a position, both in new-text offsets. */
export type PreviewMarks = {
  inserted: { from: number; to: number }[];
  removed: { at: number; text: string }[];
};

/** Turns a diff into marks over the `after` text. */
export function previewMarks(parts: Part[]): PreviewMarks {
  const marks: PreviewMarks = { inserted: [], removed: [] };
  let at = 0;
  for (const part of parts) {
    if (part.kind === 'delete') marks.removed.push({ at, text: part.text });
    else {
      if (part.kind === 'insert') marks.inserted.push({ from: at, to: at + part.text.length });
      at += part.text.length;
    }
  }
  return marks;
}

/** A replacement in old-text offsets, in the shape CodeMirror's `changes` takes. */
export type Edit = { from: number; to: number; insert: string };

/** The smallest set of replacements that turns `before` into `after`, by token. */
export function minimalEdits(before: string, after: string): Edit[] {
  const edits: Edit[] = [];
  let at = 0;
  let open: Edit | undefined; // the edit for the change group being walked
  for (const part of diff(before, after)) {
    if (part.kind === 'equal') { at += part.text.length; open = undefined; continue; }
    if (!open) edits.push(open = { from: at, to: at, insert: '' });
    if (part.kind === 'delete') { at += part.text.length; open.to = at; }
    else open.insert += part.text;
  }
  return edits;
}
