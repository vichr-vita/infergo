// The code pane's save machine, kept apart from CodeMirror so sync.test.ts can
// drive it. A Sync describes one buffer: the rule it edits, the disk version it
// is based on (the `base` hash that replace_source carries), the write in
// flight, and the problem the heading shows. The pane calls these functions
// and applies the text they return; they never touch the editor themselves.
import type { Op, Refusal, Rule } from '../protocol';
import { declName, refusalLine } from './lines';

/**
 * Why the buffer is not saved. `syntax` and `refused` hold the text the
 * server turned down, so the same text is not sent again. `stale` means the
 * declaration changed on disk under unsaved text, and holds the disk version
 * for the two choices.
 */
export type Problem =
  | { kind: 'syntax'; line?: number; message: string; text: string }
  | { kind: 'refused'; message: string; text: string }
  | { kind: 'failed'; message: string; text: string }
  | { kind: 'stale'; hash: string; source: string };

export type Sync = {
  /** The rule id the buffer edits. It changes when the buffer renames the function and the write lands. */
  rule: string;
  /** sourceHash of the disk version the buffer started from or last wrote. */
  base: string;
  /** That version's text. The buffer is dirty when it differs. */
  baseText: string;
  /** False after a write without formatting, so leaving the pane formats it. */
  formatted: boolean;
  /** The replace_source in flight. */
  sent?: { text: string; format: boolean; renameTo?: string };
  /** A write the server accepted whose model has not arrived yet. */
  landed?: { revision: number; text: string; format: boolean };
  problem?: Problem;
};

/** What the pane should do after a step: put `load` into the buffer when present. */
export type Step = { sync: Sync; load?: string };

export function loaded(rule: Pick<Rule, 'id' | 'source' | 'sourceHash'>): Sync {
  return { rule: rule.id, base: rule.sourceHash, baseText: rule.source, formatted: true };
}

export function isDirty(sync: Sync, text: string): boolean {
  return text !== sync.baseText;
}

/**
 * Whether to send now. `idle` is the 300 ms pause, `leave` is blur or a
 * gesture elsewhere (formats), `save` is Ctrl+S (formats, and retries text a
 * request failed on). Nothing goes out while a write is in flight, while the
 * base is stale, or for text the server already refused.
 */
export function wantsSend(sync: Sync, text: string, reason: 'idle' | 'leave' | 'save'): boolean {
  if (sync.sent || sync.landed || sync.problem?.kind === 'stale') return false;
  const problem = sync.problem;
  if (problem && problem.text === text && (problem.kind !== 'failed' || reason !== 'save')) return false;
  return isDirty(sync, text) || (reason !== 'idle' && !sync.formatted);
}

/** Starts a write of `text`. Returns the op to apply. */
export function send(sync: Sync, text: string, format: boolean): { sync: Sync; op: Op } {
  const name = declName(text);
  const renameTo = name && name !== sync.rule ? name : undefined;
  return {
    sync: { ...sync, sent: { text, format, ...(renameTo ? { renameTo } : {}) } },
    op: { op: 'replace_source', rule: sync.rule, text, base: sync.base, ...(format ? { format: true } : {}) },
  };
}

/** A user edit: a problem tied to other text no longer applies. */
export function edited(sync: Sync, text: string): Sync {
  const problem = sync.problem;
  if (!problem || problem.kind === 'stale' || problem.text === text) return sync;
  const { problem: _, ...rest } = sync;
  return rest;
}

export type Reply =
  | { kind: 'ok'; revision: number }
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'failed'; error: string };

/**
 * The server answered the write in flight. On success the buffer follows a
 * rename and waits for the model of that revision (see settle). A refusal
 * becomes the problem the heading shows.
 */
export function replied(sync: Sync, reply: Reply): Sync {
  const sent = sync.sent;
  if (!sent) return sync;
  const { sent: _, ...rest } = sync;
  switch (reply.kind) {
    case 'ok':
      return { ...rest, rule: sent.renameTo ?? sync.rule, landed: { revision: reply.revision, text: sent.text, format: sent.format } };
    case 'refused': {
      const { refusal } = reply;
      if (refusal.reason === 'stale_base') return rest; // settle sees the new hash and offers the choices
      // The server refuses a write that changes no bytes: the text on disk is already this text, formatted.
      if (refusal.reason === 'exists' && sent.text === sync.baseText) return { ...rest, formatted: true };
      if (refusal.reason === 'syntax_error') {
        const line = refusalLine(refusal.message);
        return { ...rest, problem: { kind: 'syntax', message: refusal.message, text: sent.text, ...(line ? { line } : {}) } };
      }
      return { ...rest, problem: { kind: 'refused', message: refusal.message, text: sent.text } };
    }
    case 'failed':
      return { ...rest, problem: { kind: 'failed', message: reply.error, text: sent.text } };
  }
}

/**
 * Reconciles the buffer with the newest model. `rule` is the model's version
 * of `sync.rule` (undefined when it is gone), `text` the buffer, `revision`
 * the model's. Called on every model change and after every reply.
 *
 * - A write in flight waits for its reply.
 * - Our accepted write adopts the model's hash. When the buffer still holds
 *   what was sent and the server stored something else (formatted, trimmed),
 *   the buffer loads it.
 * - A clean buffer follows the disk.
 * - A dirty buffer whose base moved gets the stale problem and its choices.
 */
export function settle(sync: Sync, rule: Pick<Rule, 'source' | 'sourceHash'> | undefined, text: string, revision: number): Step {
  if (sync.sent || !rule) return { sync };
  const adopt = (formatted: boolean): Sync => {
    const { problem: _, landed: __, ...rest } = sync;
    return { ...rest, base: rule.sourceHash, baseText: rule.source, formatted };
  };
  if (sync.landed) {
    if (revision < sync.landed.revision) return { sync };
    const next = adopt(sync.landed.format);
    return text === sync.landed.text && rule.source !== text ? { sync: next, load: rule.source } : { sync: next };
  }
  if (rule.sourceHash === sync.base) {
    return sync.problem?.kind === 'stale' ? { sync: adopt(sync.formatted) } : { sync };
  }
  if (text === rule.source) return { sync: adopt(true) };
  if (!isDirty(sync, text)) return { sync: adopt(true), load: rule.source };
  return { sync: { ...sync, problem: { kind: 'stale', hash: rule.sourceHash, source: rule.source } } };
}

/** "Load the version on disk": the buffer takes the disk text, as one undo step. */
export function loadDisk(sync: Sync): Step {
  if (sync.problem?.kind !== 'stale') return { sync };
  const { hash, source } = sync.problem;
  const { problem: _, ...rest } = sync;
  return { sync: { ...rest, base: hash, baseText: source, formatted: true }, load: source };
}

/** "Keep my text": rebase onto the disk version so the next write overwrites it. */
export function keepMine(sync: Sync): Sync {
  if (sync.problem?.kind !== 'stale') return sync;
  const { hash, source } = sync.problem;
  const { problem: _, ...rest } = sync;
  return { ...rest, base: hash, baseText: source };
}
