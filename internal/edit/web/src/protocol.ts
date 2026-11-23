// Wire types shared with the Go server. internal/edit/protocol mirrors every
// type here with the same JSON names, and both sides check themselves against
// the files in ../fixtures. Keep this file free of runtime code except the
// exported constants.
//
// HTTP: every /api request carries the session token as the query parameter
// `token`. Success is status 200 with the reply as JSON. A Refusal is status
// 409 with the Refusal as the body. Any other failure is a 4xx or 5xx status
// with an ErrorReply.

/** Route paths of the HTTP API, relative to the server root. */
export const paths = {
  model: '/api/model',
  events: '/api/events',
  preview: '/api/preview',
  apply: '/api/apply',
  undo: '/api/undo',
  redo: '/api/redo',
  values: '/api/values',
} as const;

/** Query parameter carrying the session token on every /api request and on the page URL. */
export const tokenParam = 'token';

/** HTTP status of a reply whose body is a Refusal. */
export const refusalStatus = 409;

/** Names of the server-sent events. Each has one JSON data line of the type in the map. */
export const eventNames = { model: 'model', check: 'check', values: 'values', history: 'history' } as const;

/** Maps each server-sent event name to the type of its data line. */
export type EventPayloads = { model: Model; check: Check; values: Values; history: History };

/** A place in a source file. Line and column are 1-based, the path is relative to the ruleset directory. */
export type Position = { file: string; line: number; column: number };

/** A named, typed fact. The type is spelled as in the source it was read from, such as `Role` or `*uint64`. */
export type Fact = { name: string; type: string };

/** One file the workspace tracks. `hash` covers the bytes the model was built from. A syntax_error file carries the first parser problem. */
export type SourceFile = {
  path: string;
  hash: string;
  state: 'ok' | 'syntax_error';
  problem?: Position & { message: string };
};

/** One field of an input or output struct: Go field name, fact name from its tag, type, and line. */
export type ContractField = { field: string; fact: string; type: string; line: number };

/** The input or output struct. `editable` is false when it is declared outside the ruleset package. */
export type Contract = { type: string; file: string; editable: boolean; fields: ContractField[] };

/**
 * One rule function as the parse sees it. `source` is the doc comment and the
 * declaration as on disk without a trailing newline, and `sourceHash` hashes
 * those bytes. `requirement` is the doc comment as one paragraph. `line` is the
 * line of the func keyword. `reads` and `produces` leave out a leading
 * context.Context and a trailing error result.
 */
export type Rule = {
  id: string; // function name
  file: string;
  line: number;
  requirement: string;
  source: string;
  sourceHash: string; // base for replace_source
  reads: Fact[]; // ordinary parameters, in order
  produces: Fact[]; // named ordinary results, in order
  usesContext: boolean;
  returnsError: boolean;
  stub: boolean;
  unsupported?: string; // why structural edits are off for this rule
};

/** The whole ruleset, sent whole on every change so the page never patches state. */
export type Model = {
  revision: number; // bumped on every accepted change, from any source
  package: string;
  files: SourceFile[];
  inputs: Contract;
  outputs: Contract;
  rules: Rule[]; // in source order
};

/**
 * One named gesture. Required arguments per operation are in the union.
 * `rename_fact` with a `rule` restricts the rename to that rule's own result,
 * which is how one of two producers of a fact gets renamed. `replace_source`
 * with `format` asks the server to gofmt the declaration and fix imports.
 */
export type Op =
  | { op: 'add_read'; rule: string; fact: string; type: string }
  | { op: 'remove_read'; rule: string; fact: string }
  | { op: 'add_rule'; name: string; reads: Fact[]; produces: Fact[]; after?: string }
  | { op: 'delete_rule'; rule: string }
  | { op: 'rename_rule'; rule: string; to: string }
  | { op: 'rename_fact'; fact: string; to: string; rule?: string }
  | { op: 'set_requirement'; rule: string; text: string }
  | { op: 'add_produce'; rule: string; fact: string; type: string }
  | { op: 'remove_produce'; rule: string; fact: string }
  | { op: 'set_type'; rule: string; fact: string; type: string }
  | { op: 'add_input'; fact: string; type: string }
  | { op: 'remove_input'; fact: string }
  | { op: 'set_requested'; fact: string; requested: boolean }
  | { op: 'replace_source'; rule: string; text: string; base: string; format?: boolean };

/** The effect of an operation on one declaration: a diff preview and part of the apply reply. */
export type Change = { file: string; rule?: string; before: string; after: string };

/** Why the server declined an operation, an undo, or a redo. `related` names rules, such as those on a cycle. */
export type Refusal = {
  reason: 'cycle' | 'exists' | 'not_found' | 'shadow' | 'unsupported' | 'syntax_error' | 'stale_base' | 'conflict';
  message: string;
  related?: string[];
};

/** Line counts one write added to and removed from a file. */
export type ReceiptFile = { path: string; added: number; removed: number };

/**
 * One history entry. `time` is RFC 3339. `undoable` is absent when the entry
 * can be undone and false once an outside edit made that impossible. `note`
 * carries an extra remark such as "also formatted bonus.go".
 */
export type Receipt = {
  id: number;
  label: string;
  source: 'editor' | 'disk';
  files: ReceiptFile[];
  time: string;
  undoable?: boolean;
  note?: string;
};

/** The undo journal. Entries before `cursor` can be undone, entries from `cursor` on can be redone. */
export type History = { entries: Receipt[]; cursor: number };

/** The compiler's verdict on one revision. `pruned` lists rules no requested output needs. */
export type Check = {
  revision: number;
  ok: boolean;
  diagnostics: Diagnostic[];
  pruned: string[]; // rules no output needs
  evaluator: 'current' | 'updated' | 'kept';
};

/** One repair offered on a diagnostic: the link label and the ordinary operation that applies it. */
export type Fix = { label: string; op: Op };

/** One compiler finding, drawn on the thing it is about. `fixes` is always an array. */
export type Diagnostic = Partial<Position> & {
  severity: 'error' | 'warning';
  kind:
    | 'missing_producer' | 'type_mismatch' | 'duplicate_producer' | 'cycle' | 'signature'
    | 'contract' | 'reserved' | 'go' | 'unused_rule' | 'unused_input';
  message: string;
  rule?: string;
  fact?: string;
  related?: string[]; // cycle: rules in order. duplicate_producer: the other rule
  fixes: Fix[];
};

/** Outcome of one rule in one case, as in the offline viewer. `facts` is null for a rule that did not run. */
export type Trace = {
  rule: string;
  kind: 'succeeded' | 'failed' | 'canceled' | 'not_run';
  error?: string;
  facts: Record<string, string> | null;
};

/** The values of one saved case, in the shape the offline viewer renders. */
export type Snapshot = { id: string; label: string; inputs: Record<string, string>; trace: Trace[]; error?: string };

/** Payload of a values event: the snapshots of every saved case for one revision. */
export type Values = { revision: number; cases: Snapshot[]; error?: string };

/** Body of POST /api/preview and POST /api/apply. */
export type OpRequest = { op: Op };

/** Reply to POST /api/preview. Nothing was written. */
export type PreviewReply = { changes: Change[] };

/** Reply to POST /api/apply, /api/undo and /api/redo. */
export type ApplyReply = { revision: number; receipt: Receipt };

/** Body of POST /api/values: turns scenario runs on or off for the session. */
export type ValuesRequest = { enabled: boolean };

/** Body of every failure that is not a Refusal. */
export type ErrorReply = { error: string };
