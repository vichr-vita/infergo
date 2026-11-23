// Package protocol defines the wire types shared by the editor server and the
// editor page. internal/edit/web/src/protocol.ts mirrors every type here with
// the same JSON names, and both sides check themselves against the fixture
// files in internal/edit/web/fixtures.
//
// HTTP: GET /api/model, GET /api/events (server-sent events), POST
// /api/preview, /api/apply, /api/undo, /api/redo and /api/values. Every
// request carries the session token as the query parameter "token". Success is
// status 200 with the reply as JSON. A Refusal is status 409 with the Refusal
// as the body. Any other failure is a 4xx or 5xx status with an ErrorReply.
//
// Every list that the page iterates encodes as a JSON array, never null. The
// MarshalJSON methods in this package enforce that, so callers may leave empty
// slices nil.
package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// Route paths of the HTTP API, relative to the server root.
const (
	PathModel   = "/api/model"
	PathEvents  = "/api/events"
	PathPreview = "/api/preview"
	PathApply   = "/api/apply"
	PathUndo    = "/api/undo"
	PathRedo    = "/api/redo"
	PathValues  = "/api/values"
)

// TokenParam is the query parameter that carries the session token on every
// /api request and on the page URL.
const TokenParam = "token"

// RefusalStatus is the HTTP status of a reply whose body is a Refusal.
const RefusalStatus = 409

// Names of the server-sent events. Each event has one JSON data line holding
// the type in the comment beside it.
const (
	EventModel   = "model"   // Model
	EventCheck   = "check"   // Check
	EventValues  = "values"  // Values
	EventHistory = "history" // History
)

// Values of SourceFile.State.
const (
	FileOK          = "ok"
	FileSyntaxError = "syntax_error"
)

// Values of Receipt.Source.
const (
	SourceEditor = "editor"
	SourceDisk   = "disk"
)

// Values of Check.Evaluator.
const (
	EvaluatorCurrent = "current"
	EvaluatorUpdated = "updated"
	EvaluatorKept    = "kept"
)

// Values of Diagnostic.Severity.
const (
	SeverityError   = "error"
	SeverityWarning = "warning"
)

// Values of Diagnostic.Kind.
const (
	KindMissingProducer   = "missing_producer"
	KindTypeMismatch      = "type_mismatch"
	KindDuplicateProducer = "duplicate_producer"
	KindCycle             = "cycle"
	KindSignature         = "signature"
	KindContract          = "contract"
	KindReserved          = "reserved"
	KindGo                = "go"
	KindUnusedRule        = "unused_rule"
	KindUnusedInput       = "unused_input"
)

// Values of Trace.Kind, as in the offline viewer.
const (
	TraceSucceeded = "succeeded"
	TraceFailed    = "failed"
	TraceCanceled  = "canceled"
	TraceNotRun    = "not_run"
)

// Hash returns the lowercase hex SHA-256 of the exact bytes. It is the hash
// used for SourceFile.Hash, Rule.SourceHash and Op.Base.
func Hash(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// nonNil returns an empty slice in place of nil so that it encodes as [].
func nonNil[S ~[]E, E any](s S) S {
	if s == nil {
		return S{}
	}
	return s
}

// Position is a place in a source file. Line and column are 1-based and the
// path is relative to the ruleset directory.
type Position struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
}

// Fact is a named, typed fact. The type is spelled as in the source of the
// declaration it was read from, for example "Role" or "*uint64".
type Fact struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// FileProblem is why a file is in the syntax_error state: the first error the
// parser reported, with its position.
type FileProblem struct {
	Position
	Message string `json:"message"`
}

// SourceFile is one file the workspace tracks. Hash is the hash of the bytes
// the model was built from, and State says whether those bytes parsed.
type SourceFile struct {
	Path    string       `json:"path"`
	Hash    string       `json:"hash"`
	State   string       `json:"state"`
	Problem *FileProblem `json:"problem,omitempty"`
}

// ContractField is one field of an input or output struct. Field is the Go
// field name, Fact the name from its fact tag, and Line its 1-based line.
type ContractField struct {
	Field string `json:"field"`
	Fact  string `json:"fact"`
	Type  string `json:"type"`
	Line  int    `json:"line"`
}

// Contract describes the input or output struct. Editable is false for a
// contract declared outside the ruleset package, which the server shows from
// the last successful check and never rewrites.
type Contract struct {
	Type     string          `json:"type"`
	File     string          `json:"file"`
	Editable bool            `json:"editable"`
	Fields   []ContractField `json:"fields"`
}

// MarshalJSON encodes a nil Fields as an empty array.
func (c Contract) MarshalJSON() ([]byte, error) {
	type plain Contract
	c.Fields = nonNil(c.Fields)
	return json.Marshal(plain(c))
}

// Rule is one rule function as the parse sees it. Source is the doc comment
// and the declaration exactly as on disk, without a trailing newline, and
// SourceHash is the hash of those bytes. Requirement is the doc comment as one
// paragraph: markers stripped, lines joined by single spaces, including the
// leading rule name. Line is the line of the func keyword. Reads and Produces
// leave out a leading context.Context parameter and a trailing error result.
// Stub marks a rule created by add_rule that still has its placeholder body.
// A non-empty Unsupported says why structural edits are off for this rule.
type Rule struct {
	ID           string `json:"id"`
	File         string `json:"file"`
	Line         int    `json:"line"`
	Requirement  string `json:"requirement"`
	Source       string `json:"source"`
	SourceHash   string `json:"sourceHash"`
	Reads        []Fact `json:"reads"`
	Produces     []Fact `json:"produces"`
	UsesContext  bool   `json:"usesContext"`
	ReturnsError bool   `json:"returnsError"`
	Stub         bool   `json:"stub"`
	Unsupported  string `json:"unsupported,omitempty"`
}

// MarshalJSON encodes nil Reads and Produces as empty arrays.
func (r Rule) MarshalJSON() ([]byte, error) {
	type plain Rule
	r.Reads, r.Produces = nonNil(r.Reads), nonNil(r.Produces)
	return json.Marshal(plain(r))
}

// Model is the whole ruleset as the page draws it. The server sends it whole
// on every change, so the page never patches state. Revision is bumped on
// every accepted change, from any source. Rules are in source order.
type Model struct {
	Revision int          `json:"revision"`
	Package  string       `json:"package"`
	Files    []SourceFile `json:"files"`
	Inputs   Contract     `json:"inputs"`
	Outputs  Contract     `json:"outputs"`
	Rules    []Rule       `json:"rules"`
}

// MarshalJSON encodes nil Files and Rules as empty arrays.
func (m Model) MarshalJSON() ([]byte, error) {
	type plain Model
	m.Files, m.Rules = nonNil(m.Files), nonNil(m.Rules)
	return json.Marshal(plain(m))
}

// Change is the effect of an operation on one declaration, shown as a diff
// preview and kept in the apply reply. Before and After are the declaration
// source with its doc comment. Rule is empty for a change outside any rule,
// such as a contract field.
type Change struct {
	File   string `json:"file"`
	Rule   string `json:"rule,omitempty"`
	Before string `json:"before"`
	After  string `json:"after"`
}

// Values of Refusal.Reason.
const (
	ReasonCycle       = "cycle"
	ReasonExists      = "exists"
	ReasonNotFound    = "not_found"
	ReasonShadow      = "shadow"
	ReasonUnsupported = "unsupported"
	ReasonSyntaxError = "syntax_error"
	ReasonStaleBase   = "stale_base"
	ReasonConflict    = "conflict"
)

// Refusal is why the server declined an operation, an undo or a redo. It is an
// error value, so the packages that apply operations return it as an error and
// the HTTP layer recovers it with AsRefusal and sends it with RefusalStatus.
// Related names rules, for example the rules on a cycle.
type Refusal struct {
	Reason  string   `json:"reason"`
	Message string   `json:"message"`
	Related []string `json:"related,omitempty"`
}

// Error returns the message, which is written for the person using the page.
func (r Refusal) Error() string { return r.Message }

// ReceiptFile counts the lines one write added to and removed from a file.
type ReceiptFile struct {
	Path    string `json:"path"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
}

// Receipt is one history entry: a sentence saying what a write did, the files
// it touched, and when. Source says whether the editor or an outside edit made
// it. Time is RFC 3339. Undoable is absent when the entry can be undone, and
// false once an outside edit made that impossible; use CanUndo to read it.
// Note carries an extra remark, such as "also formatted bonus.go".
type Receipt struct {
	ID       int           `json:"id"`
	Label    string        `json:"label"`
	Source   string        `json:"source"`
	Files    []ReceiptFile `json:"files"`
	Time     string        `json:"time"`
	Undoable *bool         `json:"undoable,omitempty"`
	Note     string        `json:"note,omitempty"`
}

// CanUndo reports whether the entry can still be undone, treating an absent
// Undoable as true.
func (r Receipt) CanUndo() bool { return r.Undoable == nil || *r.Undoable }

// MarshalJSON encodes nil Files as an empty array.
func (r Receipt) MarshalJSON() ([]byte, error) {
	type plain Receipt
	r.Files = nonNil(r.Files)
	return json.Marshal(plain(r))
}

// History is the undo journal. Entries before Cursor are applied and can be
// undone, and entries from Cursor on can be redone.
type History struct {
	Entries []Receipt `json:"entries"`
	Cursor  int       `json:"cursor"`
}

// MarshalJSON encodes nil Entries as an empty array.
func (h History) MarshalJSON() ([]byte, error) {
	type plain History
	h.Entries = nonNil(h.Entries)
	return json.Marshal(plain(h))
}

// Fix is one repair offered on a diagnostic: a label for the link and the
// ordinary operation that applies it.
type Fix struct {
	Label string `json:"label"`
	Op    Op     `json:"op"`
}

// Diagnostic is one finding of the compiler check, attached to the thing it is
// about. File, Line and Column are set together when the finding has a
// position. Related is for a cycle, its rules in order, and for a duplicate
// producer, the other rule. Fixes is always an array.
type Diagnostic struct {
	File     string   `json:"file,omitempty"`
	Line     int      `json:"line,omitempty"`
	Column   int      `json:"column,omitempty"`
	Severity string   `json:"severity"`
	Kind     string   `json:"kind"`
	Message  string   `json:"message"`
	Rule     string   `json:"rule,omitempty"`
	Fact     string   `json:"fact,omitempty"`
	Related  []string `json:"related,omitempty"`
	Fixes    []Fix    `json:"fixes"`
}

// MarshalJSON encodes nil Fixes as an empty array.
func (d Diagnostic) MarshalJSON() ([]byte, error) {
	type plain Diagnostic
	d.Fixes = nonNil(d.Fixes)
	return json.Marshal(plain(d))
}

// Check is the compiler's verdict on one revision. Pruned lists the rules that
// no requested output needs. Evaluator says whether the generated evaluator on
// disk matched the ruleset (current), was rewritten (updated), or was left
// alone because the check failed (kept).
type Check struct {
	Revision    int          `json:"revision"`
	OK          bool         `json:"ok"`
	Diagnostics []Diagnostic `json:"diagnostics"`
	Pruned      []string     `json:"pruned"`
	Evaluator   string       `json:"evaluator"`
}

// MarshalJSON encodes nil Diagnostics and Pruned as empty arrays.
func (c Check) MarshalJSON() ([]byte, error) {
	type plain Check
	c.Diagnostics, c.Pruned = nonNil(c.Diagnostics), nonNil(c.Pruned)
	return json.Marshal(plain(c))
}

// Trace is the outcome of one rule in one case, as in the offline viewer. Facts
// holds the printed values of the facts the rule produced and is null for a
// rule that did not run.
type Trace struct {
	Rule  string            `json:"rule"`
	Kind  string            `json:"kind"`
	Error string            `json:"error,omitempty"`
	Facts map[string]string `json:"facts"`
}

// Snapshot is the values of one saved case, in the shape the offline viewer
// renders. Error is set when the evaluation as a whole failed.
type Snapshot struct {
	ID     string            `json:"id"`
	Label  string            `json:"label"`
	Inputs map[string]string `json:"inputs"`
	Trace  []Trace           `json:"trace"`
	Error  string            `json:"error,omitempty"`
}

// MarshalJSON encodes a nil Inputs as an empty object and a nil Trace as an
// empty array.
func (s Snapshot) MarshalJSON() ([]byte, error) {
	type plain Snapshot
	if s.Inputs == nil {
		s.Inputs = map[string]string{}
	}
	s.Trace = nonNil(s.Trace)
	return json.Marshal(plain(s))
}

// Values is the payload of a values event: the snapshots of every saved case
// for one revision. Error says why no case could be run.
type Values struct {
	Revision int        `json:"revision"`
	Cases    []Snapshot `json:"cases"`
	Error    string     `json:"error,omitempty"`
}

// MarshalJSON encodes nil Cases as an empty array.
func (v Values) MarshalJSON() ([]byte, error) {
	type plain Values
	v.Cases = nonNil(v.Cases)
	return json.Marshal(plain(v))
}

// OpRequest is the body of POST /api/preview and POST /api/apply.
type OpRequest struct {
	Op Op `json:"op"`
}

// PreviewReply is the reply to POST /api/preview. Nothing was written.
type PreviewReply struct {
	Changes []Change `json:"changes"`
}

// MarshalJSON encodes nil Changes as an empty array.
func (p PreviewReply) MarshalJSON() ([]byte, error) {
	type plain PreviewReply
	p.Changes = nonNil(p.Changes)
	return json.Marshal(plain(p))
}

// ApplyReply is the reply to POST /api/apply, /api/undo and /api/redo. Revision
// is the revision the write produced.
type ApplyReply struct {
	Revision int     `json:"revision"`
	Receipt  Receipt `json:"receipt"`
}

// ValuesRequest is the body of POST /api/values. Enabled turns scenario runs on
// or off for the session.
type ValuesRequest struct {
	Enabled bool `json:"enabled"`
}

// ErrorReply is the body of every failure that is not a Refusal.
type ErrorReply struct {
	Error string `json:"error"`
}
