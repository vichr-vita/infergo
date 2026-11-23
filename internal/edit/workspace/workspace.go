// Package workspace owns the editor's view of a ruleset directory: the bytes of
// its Go files, every write the editor makes, the history of those writes, and
// a watcher that notices edits made by other programs. The server calls it for
// every operation and forwards its events to the page.
package workspace

import (
	"bytes"
	"errors"
	"fmt"
	"go/format"
	"go/parser"
	"go/scanner"
	"go/token"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
	"github.com/vichr-vita/infergo/internal/edit/source"
)

// ErrStale is returned by WriteEvaluator when the files changed after the
// revision the evaluator was generated from. A newer check will follow.
var ErrStale = errors.New("the ruleset changed since this check started")

// ErrClosed is returned by every method that needs the workspace after Close.
var ErrClosed = errors.New("workspace is closed")

// collectWindow is how long the watcher gathers file events before it rereads
// the directory, so that one save, which editors often perform as several
// events, becomes one change.
const collectWindow = 50 * time.Millisecond

// mergeWindow is how long a replace_source entry stays open for the next
// keystroke of the same rule.
const mergeWindow = 2 * time.Second

// Options configures Open. Config names the rule files and contracts, as the
// generator takes them. Evaluator is the generated evaluator's file name in the
// directory: the workspace never treats it as source, the watcher ignores it,
// and WriteEvaluator is the only way to change it. WriteEvaluator writes a
// file only when its content differs and reports whether it wrote; infergen
// passes the generator's own writer. Logf reports failures that have no caller
// to return to, such as a watcher error, and defaults to the standard logger.
type Options struct {
	Config         source.Config
	Evaluator      string
	WriteEvaluator func(path string, content []byte) (bool, error)
	Logf           func(format string, args ...any)
}

// Event is a change the workspace made or noticed. Model is set when the files
// changed and History when the journal changed. Events coalesce: a consumer
// that falls behind receives the newest state rather than every step, so a slow
// consumer never delays a write.
type Event struct {
	Model   *protocol.Model
	History *protocol.History
}

// Workspace holds the state of one ruleset directory. Open creates it and Close
// releases its watcher. All methods are safe for concurrent use.
type Workspace struct {
	dir            string
	config         source.Config
	evaluator      string
	writeEvaluator func(path string, content []byte) (bool, error)
	logf           func(format string, args ...any)
	now            func() time.Time

	mu       sync.Mutex
	files    map[string]*file
	revision int
	model    protocol.Model
	journal  journal
	closed   bool

	// pendingModel and pendingHistory are guarded by mu and tell the event
	// pump what to send next. signal wakes the pump.
	pendingModel, pendingHistory bool
	signal                       chan struct{}
	events                       chan Event

	watcher *fsnotify.Watcher
	done    chan struct{}
	wait    sync.WaitGroup
}

// file is the workspace's record of one Go source file: the bytes last read
// from or written to disk, the stat values that tell whether to reread it, and
// the newest bytes that parsed, which the model keeps while the file is broken.
type file struct {
	content []byte
	hash    string
	size    int64
	modTime time.Time
	mode    os.FileMode
	parsed  []byte
	problem *protocol.FileProblem
}

// Open reads every Go file in dir except the evaluator and starts watching the
// directory. It fails if a Go file is a symbolic link or not a regular file,
// because the editor would otherwise write through it.
func Open(dir string, options Options) (*Workspace, error) {
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if err := checkFileName(options.Evaluator); err != nil {
		return nil, fmt.Errorf("evaluator: %w", err)
	}
	if len(options.Config.RuleFiles) == 0 {
		return nil, errors.New("rule files are required")
	}
	for _, name := range options.Config.RuleFiles {
		if err := checkFileName(name); err != nil {
			return nil, fmt.Errorf("rule file: %w", err)
		}
		if name == options.Evaluator {
			return nil, fmt.Errorf("rule file %s is the generated evaluator", name)
		}
	}
	if options.WriteEvaluator == nil {
		return nil, errors.New("an evaluator writer is required")
	}
	if options.Logf == nil {
		options.Logf = log.Printf
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("watch %s: %w", absolute, err)
	}
	// Watch before the first read, so a save between the two is not lost.
	if err := watcher.Add(absolute); err != nil {
		watcher.Close()
		return nil, fmt.Errorf("watch %s: %w", absolute, err)
	}
	w := &Workspace{
		dir:            absolute,
		config:         options.Config,
		evaluator:      options.Evaluator,
		writeEvaluator: options.WriteEvaluator,
		logf:           options.Logf,
		now:            time.Now,
		files:          map[string]*file{},
		revision:       1,
		signal:         make(chan struct{}, 1),
		events:         make(chan Event),
		watcher:        watcher,
		done:           make(chan struct{}),
	}
	files, err := w.scan(true)
	if err != nil {
		watcher.Close()
		return nil, err
	}
	w.files = files
	w.buildModelLocked()
	w.wait.Add(2)
	go w.pump()
	go w.watch()
	return w, nil
}

// checkFileName accepts a plain .go file name with no directory part.
func checkFileName(name string) error {
	if name == "" || name != filepath.Base(name) || filepath.Ext(name) != ".go" || !isSourceName(name) {
		return fmt.Errorf("%q must be a .go file name in the ruleset directory", name)
	}
	return nil
}

// isSourceName reports whether the go tool would read a file of this name.
// It skips names starting with "." or "_", which also keeps the temporary
// files of a write out of the workspace.
func isSourceName(name string) bool {
	return strings.HasSuffix(name, ".go") && !strings.HasPrefix(name, ".") && !strings.HasPrefix(name, "_")
}

// Close stops the watcher and closes the Events channel. Later calls that need
// the files return ErrClosed.
func (w *Workspace) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	w.mu.Unlock()
	close(w.done)
	err := w.watcher.Close()
	w.wait.Wait()
	close(w.events)
	return err
}

// Dir returns the absolute path of the ruleset directory.
func (w *Workspace) Dir() string { return w.dir }

// Config returns the rule files and contract names the workspace was opened with.
func (w *Workspace) Config() source.Config { return w.config }

// Evaluator returns the generated evaluator's file name.
func (w *Workspace) Evaluator() string { return w.evaluator }

// Events delivers model and history changes from every source: operations,
// undo and redo, and outside edits. There is one channel per workspace, meant
// for one consumer. It is closed by Close.
func (w *Workspace) Events() <-chan Event { return w.events }

// Model returns the current model. Callers must treat it as read-only, since
// it is shared with later callers.
func (w *Workspace) Model() protocol.Model {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.model
}

// Revision returns the current revision, which every accepted change bumps.
func (w *Workspace) Revision() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.revision
}

// History returns the journal as the page shows it.
func (w *Workspace) History() protocol.History {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.journal.history()
}

// Preview returns what op would change, from the files as they are on disk
// now. It writes nothing.
func (w *Workspace) Preview(op protocol.Op) ([]protocol.Change, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil, ErrClosed
	}
	if err := w.refreshLocked(false); err != nil {
		return nil, err
	}
	result, err := w.runLocked(op)
	if err != nil {
		return nil, err
	}
	if _, err := w.verifyLocked(op, result); err != nil {
		return nil, err
	}
	return result.Changes, nil
}

// Apply performs op on the files as they are on disk now, writes each changed
// file atomically, records a history entry, and bumps the revision. A refusal
// comes back as a protocol.Refusal error and nothing is written.
func (w *Workspace) Apply(op protocol.Op) (protocol.Receipt, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return protocol.Receipt{}, ErrClosed
	}
	if err := w.refreshLocked(false); err != nil {
		return protocol.Receipt{}, err
	}
	result, err := w.runLocked(op)
	if err != nil {
		return protocol.Receipt{}, err
	}
	note, err := w.verifyLocked(op, result)
	if err != nil {
		return protocol.Receipt{}, err
	}
	changes := make([]fileChange, 0, len(result.Files))
	for _, path := range sortedKeys(result.Files) {
		after := result.Files[path]
		change := fileChange{path: path, after: after, afterExists: true}
		if current := w.files[path]; current != nil {
			change.before, change.beforeExists = current.content, true
		}
		if change.beforeExists && bytes.Equal(change.before, change.after) {
			continue
		}
		changes = append(changes, change)
	}
	if len(changes) == 0 {
		return protocol.Receipt{}, protocol.Refusal{Reason: protocol.ReasonExists, Message: "The operation changes nothing."}
	}
	written, err := w.writeChangesLocked(changes)
	if len(written) == 0 {
		return protocol.Receipt{}, err
	}
	receipt := w.journal.record(written, result.Label, protocol.SourceEditor, note, w.now(), mergeKey(op))
	w.changedLocked(true)
	if err != nil {
		// Some files reached disk. The entry records them so undo can revert.
		return protocol.Receipt{}, fmt.Errorf("partly applied %q: %w", result.Label, err)
	}
	return receipt, nil
}

// Undo writes back the files of the newest applied entry. It refuses with
// conflict when a file no longer holds the bytes that entry wrote.
func (w *Workspace) Undo() (protocol.Receipt, error) {
	return w.step(true)
}

// Redo writes again the files of the oldest undone entry. It refuses with
// conflict when a file no longer holds the bytes the undo left.
func (w *Workspace) Redo() (protocol.Receipt, error) {
	return w.step(false)
}

// step performs an undo or a redo. The receipt it returns is the entry's own,
// with the label prefixed by Undo or Redo and, for an undo, the line counts
// swapped to describe the write it just made.
func (w *Workspace) step(undo bool) (protocol.Receipt, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return protocol.Receipt{}, ErrClosed
	}
	if err := w.refreshLocked(false); err != nil {
		return protocol.Receipt{}, err
	}
	index := w.journal.cursor
	verb := "redo"
	if undo {
		index--
		verb = "undo"
	}
	if index < 0 || index >= len(w.journal.entries) {
		return protocol.Receipt{}, protocol.Refusal{Reason: protocol.ReasonNotFound, Message: "Nothing to " + verb + "."}
	}
	entry := &w.journal.entries[index]
	if undo && !entry.receipt.CanUndo() {
		return protocol.Receipt{}, protocol.Refusal{Reason: protocol.ReasonConflict, Message: fmt.Sprintf("%q can no longer be undone here, because %s changed in another editor.", entry.receipt.Label, entry.paths())}
	}
	changes := make([]fileChange, len(entry.files))
	for i, change := range entry.files {
		if undo {
			change = change.reversed()
		}
		current := w.files[change.path]
		if (current != nil) != change.beforeExists || current != nil && !bytes.Equal(current.content, change.before) {
			return protocol.Receipt{}, protocol.Refusal{Reason: protocol.ReasonConflict, Message: fmt.Sprintf("Cannot %s %q: %s changed since.", verb, entry.receipt.Label, change.path)}
		}
		changes[i] = change
	}
	written, err := w.writeChangesLocked(changes)
	if len(written) < len(changes) {
		// A partial undo leaves the files between two entries. Record what
		// reached disk as its own entry, so the files and the journal agree.
		if len(written) > 0 {
			w.journal.record(written, "Partly "+verb+" "+entry.receipt.Label, protocol.SourceEditor, "", w.now(), "")
			w.changedLocked(true)
		}
		return protocol.Receipt{}, err
	}
	receipt := entry.receipt
	if undo {
		w.journal.cursor--
		receipt.Label = "Undo: " + receipt.Label
		for i := range receipt.Files {
			receipt.Files[i].Added, receipt.Files[i].Removed = receipt.Files[i].Removed, receipt.Files[i].Added
		}
	} else {
		w.journal.cursor++
		receipt.Label = "Redo: " + receipt.Label
	}
	receipt.Files = slices.Clone(receipt.Files)
	w.journal.mergeKey = ""
	w.changedLocked(true)
	return receipt, nil
}

// WriteEvaluator writes the generated evaluator through the writer given to
// Open, only if the files are still at revision. It returns ErrStale when they
// moved on, and refuses a symbolic link or other non-regular file at the
// evaluator's path. updated reports whether the content on disk changed.
func (w *Workspace) WriteEvaluator(revision int, content []byte) (updated bool, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return false, ErrClosed
	}
	if revision != w.revision {
		return false, ErrStale
	}
	path := filepath.Join(w.dir, w.evaluator)
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return false, fmt.Errorf("refusing to write %s, which is not a regular file", w.evaluator)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	return w.writeEvaluator(path, content)
}

// runLocked computes op's result from the current files. Operations that need
// type information load the package from disk, which refreshLocked has just
// brought in line with the files in memory.
func (w *Workspace) runLocked(op protocol.Op) (source.Result, error) {
	if err := op.Validate(); err != nil {
		return source.Result{}, err
	}
	if err := w.staleTargetLocked(op); err != nil {
		return source.Result{}, err
	}
	files := make(source.Files, len(w.files))
	for path, f := range w.files {
		files[path] = f.content
	}
	return applyOp(w.dir, files, w.config, op)
}

// staleTargetLocked refuses an operation whose target rule or contract lives
// in a file that does not parse now. The model shows that file's last parsed
// version, which the operation must not be resolved against.
func (w *Workspace) staleTargetLocked(op protocol.Op) error {
	var path string
	switch op.Op {
	case protocol.OpAddInput, protocol.OpRemoveInput:
		path = w.model.Inputs.File
	case protocol.OpSetRequested:
		path = w.model.Outputs.File
	default:
		rule := op.Rule
		if op.Op == protocol.OpAddRule {
			rule = op.After
		}
		for _, r := range w.model.Rules {
			if r.ID == rule {
				path = r.File
			}
		}
	}
	if f := w.files[path]; f != nil && f.problem != nil {
		p := f.problem
		return protocol.Refusal{Reason: protocol.ReasonSyntaxError, Message: fmt.Sprintf("%s:%d:%d: %s. Fix the file before editing it here.", p.File, p.Line, p.Column, p.Message)}
	}
	return nil
}

// verifyLocked checks every file the rewriter returned: the path is one the
// editor may write, the content parses, and, unless op is replace_source
// without format, the content is gofmt output. The note says which files were
// not formatted before and now are.
func (w *Workspace) verifyLocked(op protocol.Op, result source.Result) (note string, err error) {
	formatted := op.Op != protocol.OpReplaceSource || op.Format
	var reformatted []string
	for _, path := range sortedKeys(result.Files) {
		content := result.Files[path]
		if err := w.checkWritableLocked(path); err != nil {
			return "", err
		}
		if _, err := parser.ParseFile(token.NewFileSet(), path, content, parser.SkipObjectResolution); err != nil {
			return "", fmt.Errorf("the rewrite of %s does not parse: %w", path, err)
		}
		if !formatted {
			continue
		}
		if clean, err := format.Source(content); err != nil || !bytes.Equal(clean, content) {
			return "", fmt.Errorf("the rewrite of %s is not gofmt output", path)
		}
		if current := w.files[path]; current != nil && current.problem == nil {
			if clean, err := format.Source(current.content); err == nil && !bytes.Equal(clean, current.content) {
				reformatted = append(reformatted, path)
			}
		}
	}
	if len(reformatted) > 0 {
		note = "also formatted " + joinNames(reformatted)
	}
	return note, nil
}

// checkWritableLocked accepts only a Go file directly in the directory that is
// not the evaluator, and, if it exists, is a regular file and not a link.
func (w *Workspace) checkWritableLocked(path string) error {
	if err := checkFileName(path); err != nil || path == w.evaluator {
		return fmt.Errorf("refusing to write %q, which is not a rule source file in the ruleset directory", path)
	}
	info, err := os.Lstat(filepath.Join(w.dir, path))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("refusing to write %s, which is a symbolic link or not a regular file", path)
	}
	return nil
}

// writeChangesLocked writes each change, creating, replacing, or removing the
// file, and returns the changes that reached disk, in order, with the error
// that stopped it. Every new content is first written to a temporary file in
// the directory with the file's mode, so a failure before the renames writes
// nothing, and each rename replaces a file atomically.
func (w *Workspace) writeChangesLocked(changes []fileChange) ([]fileChange, error) {
	type staged struct {
		change fileChange
		temp   string
	}
	var ready []staged
	cleanup := func() {
		for _, s := range ready {
			if s.temp != "" {
				os.Remove(s.temp)
			}
		}
	}
	for _, change := range changes {
		if err := w.checkWritableLocked(change.path); err != nil {
			cleanup()
			return nil, err
		}
		s := staged{change: change}
		if change.afterExists {
			mode := os.FileMode(0o644)
			if current := w.files[change.path]; current != nil {
				mode = current.mode
			}
			temp, err := writeTemp(w.dir, change.after, mode)
			if err != nil {
				cleanup()
				return nil, fmt.Errorf("write %s: %w", change.path, err)
			}
			s.temp = temp
		}
		ready = append(ready, s)
	}
	var written []fileChange
	for i, s := range ready {
		path := filepath.Join(w.dir, s.change.path)
		var err error
		if s.change.afterExists {
			err = os.Rename(s.temp, path)
		} else {
			err = os.Remove(path)
		}
		if err != nil {
			ready = ready[i:]
			cleanup()
			return written, fmt.Errorf("write %s: %w", s.change.path, err)
		}
		if s.change.afterExists {
			info, err := os.Lstat(path)
			if err != nil {
				ready = ready[i+1:]
				cleanup()
				return written, err
			}
			w.files[s.change.path] = w.record(s.change.path, s.change.after, info, w.files[s.change.path])
		} else {
			delete(w.files, s.change.path)
		}
		written = append(written, s.change)
	}
	return written, nil
}

// writeTemp writes content to a new hidden file in dir with mode and returns
// its path. The name starts with a dot, so neither the go tool nor the watcher
// treats it as source.
func writeTemp(dir string, content []byte, mode os.FileMode) (string, error) {
	temp, err := os.CreateTemp(dir, ".infergen-edit-*.tmp")
	if err != nil {
		return "", err
	}
	_, err = temp.Write(content)
	if err == nil {
		err = temp.Chmod(mode.Perm())
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(temp.Name())
		return "", err
	}
	return temp.Name(), nil
}

// refreshLocked rereads the directory and turns any outside change into a disk
// history entry and a new revision. With force it reads every file; without, it
// rereads only files whose size or modification time changed.
func (w *Workspace) refreshLocked(force bool) error {
	current, err := w.scan(force)
	if err != nil {
		return err
	}
	var changes []fileChange
	for _, path := range sortedKeys(current) {
		before, after := w.files[path], current[path]
		if before == nil {
			changes = append(changes, fileChange{path: path, after: after.content, afterExists: true})
		} else if before.hash != after.hash {
			changes = append(changes, fileChange{path: path, before: before.content, beforeExists: true, after: after.content, afterExists: true})
		}
	}
	for _, path := range sortedKeys(w.files) {
		if current[path] == nil {
			changes = append(changes, fileChange{path: path, before: w.files[path].content, beforeExists: true})
		}
	}
	w.files = current
	if len(changes) == 0 {
		return nil
	}
	paths := make([]string, len(changes))
	for i, change := range changes {
		paths[i] = change.path
	}
	label := "Changed " + joinNames(paths) + " in another editor"
	w.journal.record(changes, label, protocol.SourceDisk, "", w.now(), "")
	w.changedLocked(true)
	return nil
}

// scan reads the directory's Go files. A file whose size and modification time
// match the record is reused unless force is set. A symbolic link or other
// non-regular Go file is an error.
func (w *Workspace) scan(force bool) (map[string]*file, error) {
	entries, err := os.ReadDir(w.dir)
	if err != nil {
		return nil, err
	}
	files := make(map[string]*file)
	for _, entry := range entries {
		name := entry.Name()
		if !isSourceName(name) || name == w.evaluator {
			continue
		}
		info, err := entry.Info()
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("refusing to edit a ruleset with %s, which is a symbolic link or not a regular file", name)
		}
		previous := w.files[name]
		if !force && previous != nil && previous.size == info.Size() && previous.modTime.Equal(info.ModTime()) && previous.mode == info.Mode() {
			files[name] = previous
			continue
		}
		content, err := os.ReadFile(filepath.Join(w.dir, name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		files[name] = w.record(name, content, info, previous)
	}
	return files, nil
}

// record builds the file record for content, carrying over the last parsed
// bytes from previous when content does not parse.
func (w *Workspace) record(name string, content []byte, info os.FileInfo, previous *file) *file {
	f := &file{content: content, hash: protocol.Hash(content), size: info.Size(), modTime: info.ModTime(), mode: info.Mode()}
	if previous != nil && previous.hash == f.hash {
		f.parsed, f.problem = previous.parsed, previous.problem
		return f
	}
	if _, err := parser.ParseFile(token.NewFileSet(), name, content, parser.SkipObjectResolution); err != nil {
		f.problem = problemOf(name, err)
		if previous != nil {
			f.parsed = previous.parsed
		}
		return f
	}
	f.parsed = content
	return f
}

// problemOf converts the parser's first error into a FileProblem.
func problemOf(name string, err error) *protocol.FileProblem {
	var list scanner.ErrorList
	if errors.As(err, &list) && len(list) > 0 {
		return &protocol.FileProblem{Position: protocol.Position{File: name, Line: list[0].Pos.Line, Column: list[0].Pos.Column}, Message: list[0].Msg}
	}
	return &protocol.FileProblem{Position: protocol.Position{File: name, Line: 1, Column: 1}, Message: err.Error()}
}

// changedLocked bumps the revision, rebuilds the model, and queues a model
// event, and a history event when history is set.
func (w *Workspace) changedLocked(history bool) {
	w.revision++
	w.buildModelLocked()
	w.pendingModel = true
	w.pendingHistory = w.pendingHistory || history
	select {
	case w.signal <- struct{}{}:
	default:
	}
}

// buildModelLocked parses the current files into the model. A file that does
// not parse contributes its last parsed bytes, if it ever parsed, and is
// marked syntax_error with the parser's position.
func (w *Workspace) buildModelLocked() {
	files := make(source.Files, len(w.files))
	for path, f := range w.files {
		files[path] = f.content
		if f.problem != nil && f.parsed != nil {
			files[path] = f.parsed
		}
	}
	model := source.Parse(files, w.config)
	model.Revision = w.revision
	model.Files = slices.Clone(model.Files)
	for i := range model.Files {
		if f := w.files[model.Files[i].Path]; f != nil && f.problem != nil {
			model.Files[i].State = protocol.FileSyntaxError
			model.Files[i].Problem = f.problem
		}
	}
	w.model = model
}

// pump sends queued events, always with the newest model and history, until
// Close. It runs on its own goroutine so that a slow reader holds up only it.
func (w *Workspace) pump() {
	defer w.wait.Done()
	for {
		select {
		case <-w.done:
			return
		case <-w.signal:
		}
		w.mu.Lock()
		var event Event
		if w.pendingModel {
			model := w.model
			event.Model = &model
		}
		if w.pendingHistory {
			history := w.journal.history()
			event.History = &history
		}
		w.pendingModel, w.pendingHistory = false, false
		w.mu.Unlock()
		if event.Model == nil && event.History == nil {
			continue
		}
		select {
		case w.events <- event:
		case <-w.done:
			return
		}
	}
}

// watch collects file events for collectWindow and then rereads the directory,
// until Close. Changes that only repeat the bytes the workspace already holds,
// such as its own writes, produce no event.
func (w *Workspace) watch() {
	defer w.wait.Done()
	var timer <-chan time.Time
	for {
		select {
		case <-w.done:
			return
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			name := filepath.Base(event.Name)
			if !isSourceName(name) || name == w.evaluator {
				continue
			}
			if timer == nil {
				timer = time.After(collectWindow)
			}
		case err, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
			w.logf("infergen: watch %s: %v", w.dir, err)
			// Events may have been lost, so reread everything.
			if timer == nil {
				timer = time.After(collectWindow)
			}
		case <-timer:
			timer = nil
			w.mu.Lock()
			err := ErrClosed
			if !w.closed {
				err = w.refreshLocked(true)
			}
			w.mu.Unlock()
			if err != nil && !errors.Is(err, ErrClosed) {
				w.logf("infergen: %v", err)
			}
		}
	}
}

// joinNames lists names as "a", "a and b", or "a, b, and c".
func joinNames(names []string) string {
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0]
	case 2:
		return names[0] + " and " + names[1]
	}
	return strings.Join(names[:len(names)-1], ", ") + ", and " + names[len(names)-1]
}

// sortedKeys returns a map's keys in order, for deterministic receipts.
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
