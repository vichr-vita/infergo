package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
	"github.com/vichr-vita/infergo/internal/edit/source"
)

// bonusConfig is the generator configuration of ruleset/bonus.
var bonusConfig = source.Config{RuleFiles: []string{"bonus.go"}, Inputs: "Inputs", Outputs: "Outputs"}

// addFinanceRequired is the add_read the tests apply: ReviewRequired gains the
// financeRequired fact.
var addFinanceRequired = protocol.Op{Op: protocol.OpAddRead, Rule: "ReviewRequired", Fact: "financeRequired", Type: "bool"}

// bonusModule copies ruleset/bonus into a temporary module that uses this
// checkout through a replace directive, and returns its directory.
func bonusModule(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOWORK", "off")
	dir := t.TempDir()
	module := fmt.Sprintf("module example.com/bonus\n\ngo 1.26.0\n\nrequire github.com/vichr-vita/infergo v0.0.0\n\nreplace github.com/vichr-vita/infergo => %q\n", root)
	writeFile(t, filepath.Join(dir, "go.mod"), module)
	for _, name := range []string{"bonus.go", "bonus_test.go", "facts.go", "zz_infergo_gen.go"} {
		content, err := os.ReadFile(filepath.Join(root, "ruleset", "bonus", name))
		if err != nil {
			t.Fatal(err)
		}
		writeFile(t, filepath.Join(dir, name), string(content))
	}
	return dir
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

// open opens a workspace on dir and closes it when the test ends.
func open(t *testing.T, dir string) *Workspace {
	t.Helper()
	w, err := Open(dir, Options{
		Config:    bonusConfig,
		Evaluator: "zz_infergo_gen.go",
		WriteEvaluator: func(path string, content []byte) (bool, error) {
			return true, os.WriteFile(path, content, 0o644)
		},
		Logf: t.Logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := w.Close(); err != nil {
			t.Error(err)
		}
	})
	return w
}

// waitFor reads events until one satisfies done, failing after timeout. It
// returns that event and how long it took.
func waitFor(t *testing.T, w *Workspace, timeout time.Duration, done func(Event) bool) (Event, time.Duration) {
	t.Helper()
	start := time.Now()
	deadline := time.After(timeout)
	for {
		select {
		case event := <-w.Events():
			if done(event) {
				return event, time.Since(start)
			}
		case <-deadline:
			t.Fatalf("no matching event within %v", timeout)
		}
	}
}

// waitForEntries waits until the history has n entries.
func waitForEntries(t *testing.T, w *Workspace, n int) protocol.History {
	t.Helper()
	event, _ := waitFor(t, w, 5*time.Second, func(e Event) bool { return e.History != nil && len(e.History.Entries) >= n })
	return *event.History
}

// sources lists the Source of each history entry.
func sources(history protocol.History) string {
	var names []string
	for _, entry := range history.Entries {
		names = append(names, entry.Source+":"+joinNames(filesOf(entry)))
	}
	return strings.Join(names, " ")
}

func filesOf(receipt protocol.Receipt) []string {
	var names []string
	for _, f := range receipt.Files {
		names = append(names, f.Path)
	}
	return names
}

func TestOpenRefusesSymbolicLink(t *testing.T) {
	dir := bonusModule(t)
	outside := filepath.Join(t.TempDir(), "facts.go")
	writeFile(t, outside, readFile(t, filepath.Join(dir, "facts.go")))
	if err := os.Remove(filepath.Join(dir, "facts.go")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "facts.go")); err != nil {
		t.Fatal(err)
	}
	_, err := Open(dir, Options{Config: bonusConfig, Evaluator: "zz_infergo_gen.go", WriteEvaluator: func(string, []byte) (bool, error) { return false, nil }})
	if err == nil || !strings.Contains(err.Error(), "facts.go") {
		t.Fatalf("Open with a symbolic link: %v", err)
	}
}

func TestPreviewWritesNothing(t *testing.T) {
	dir := bonusModule(t)
	w := open(t, dir)
	path := filepath.Join(dir, "bonus.go")
	before := readFile(t, path)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	changes, err := w.Preview(addFinanceRequired)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 1 || changes[0].Rule != "ReviewRequired" || !strings.Contains(changes[0].After, "financeRequired bool") {
		t.Fatalf("changes = %+v", changes)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if readFile(t, path) != before || !after.ModTime().Equal(info.ModTime()) {
		t.Fatal("preview changed bonus.go")
	}
	if w.Revision() != 1 || len(w.History().Entries) != 0 {
		t.Fatalf("preview recorded a change: revision %d, history %+v", w.Revision(), w.History())
	}
}

func TestApplyWritesAtomicallyAndReturnsReceipt(t *testing.T) {
	dir := bonusModule(t)
	path := filepath.Join(dir, "bonus.go")
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	w := open(t, dir)
	receipt, err := w.Apply(addFinanceRequired)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ID != 1 || receipt.Source != protocol.SourceEditor || receipt.Label == "" || receipt.Note != "" {
		t.Fatalf("receipt = %+v", receipt)
	}
	if len(receipt.Files) != 1 || receipt.Files[0] != (protocol.ReceiptFile{Path: "bonus.go", Added: 1, Removed: 1}) {
		t.Fatalf("receipt files = %+v", receipt.Files)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// A rename puts a new file in place, while an in-place write keeps the
	// inode.
	if os.SameFile(before, after) {
		t.Fatal("bonus.go was written in place, not replaced by a rename")
	}
	if after.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %v, want 0640", after.Mode().Perm())
	}
	if !strings.Contains(readFile(t, path), "financeRequired bool") {
		t.Fatal("bonus.go lacks the new parameter")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
	if w.Revision() != 2 {
		t.Fatalf("revision = %d, want 2", w.Revision())
	}
	model := w.Model()
	if model.Revision != 2 {
		t.Fatalf("model revision = %d", model.Revision)
	}
}

func TestApplyNotesFormatting(t *testing.T) {
	dir := bonusModule(t)
	path := filepath.Join(dir, "bonus.go")
	writeFile(t, path, strings.Replace(readFile(t, path), "package bonus\n", "package bonus\n\n\n\n", 1))
	w := open(t, dir)
	receipt, err := w.Apply(addFinanceRequired)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Note != "also formatted bonus.go" {
		t.Fatalf("note = %q", receipt.Note)
	}
}

func TestOutsideSaveProducesOneDiskEntry(t *testing.T) {
	dir := bonusModule(t)
	w := open(t, dir)
	path := filepath.Join(dir, "bonus.go")
	original := readFile(t, path)

	// Many editors save by writing a new file and renaming it into place.
	temp := filepath.Join(dir, "bonus.go~")
	writeFile(t, temp, original+"\n// Saved elsewhere.\n")
	start := time.Now()
	if err := os.Rename(temp, path); err != nil {
		t.Fatal(err)
	}
	waitFor(t, w, 5*time.Second, func(e Event) bool { return e.Model != nil && e.Model.Revision == 2 })
	if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
		t.Fatalf("model event after %v, want within 250ms", elapsed)
	}
	history := w.History()
	if len(history.Entries) != 1 || history.Cursor != 1 {
		t.Fatalf("history = %+v", history)
	}
	entry := history.Entries[0]
	if entry.Source != protocol.SourceDisk || entry.Label != "Changed bonus.go in another editor" ||
		len(entry.Files) != 1 || entry.Files[0] != (protocol.ReceiptFile{Path: "bonus.go", Added: 2, Removed: 0}) {
		t.Fatalf("entry = %+v", entry)
	}

	// A save that changes nothing is ignored. The next real change proves the
	// watcher saw it and moved on.
	writeFile(t, path, readFile(t, path))
	writeFile(t, filepath.Join(dir, "facts.go"), readFile(t, filepath.Join(dir, "facts.go"))+"\n")
	history = waitForEntries(t, w, 2)
	if got := sources(history); got != "disk:bonus.go disk:facts.go" {
		t.Fatalf("history = %s", got)
	}
}

func TestOwnWritesProduceNoHistoryEntry(t *testing.T) {
	dir := bonusModule(t)
	w := open(t, dir)
	if _, err := w.Apply(addFinanceRequired); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Undo(); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Redo(); err != nil {
		t.Fatal(err)
	}
	// An outside edit to another file arrives after the watcher has seen the
	// three writes above, so any entry they caused would come first.
	writeFile(t, filepath.Join(dir, "facts.go"), readFile(t, filepath.Join(dir, "facts.go"))+"\n")
	history := waitForEntries(t, w, 2)
	if got := sources(history); got != "editor:bonus.go disk:facts.go" {
		t.Fatalf("history = %s", got)
	}
}

func TestOperationAfterOutsideEditUsesNewContent(t *testing.T) {
	dir := bonusModule(t)
	w := open(t, dir)
	path := filepath.Join(dir, "bonus.go")
	outside := strings.Replace(readFile(t, path), "package bonus\n", "package bonus\n\n// Edited elsewhere.\n", 1)
	writeFile(t, path, outside)
	// No wait for the watcher: Apply must reread the file itself.
	if _, err := w.Apply(addFinanceRequired); err != nil {
		t.Fatal(err)
	}
	content := readFile(t, path)
	if !strings.Contains(content, "// Edited elsewhere.") || !strings.Contains(content, "financeRequired bool") {
		t.Fatalf("bonus.go lost one of the edits:\n%s", content)
	}
	if got := sources(w.History()); got != "disk:bonus.go editor:bonus.go" {
		t.Fatalf("history = %s", got)
	}
}

func TestUndoRestoresExactBytes(t *testing.T) {
	dir := bonusModule(t)
	path := filepath.Join(dir, "bonus.go")
	original := readFile(t, path)
	w := open(t, dir)
	if _, err := w.Apply(addFinanceRequired); err != nil {
		t.Fatal(err)
	}
	applied := readFile(t, path)
	receipt, err := w.Undo()
	if err != nil {
		t.Fatal(err)
	}
	if readFile(t, path) != original {
		t.Fatal("undo did not restore the original bytes")
	}
	if !strings.HasPrefix(receipt.Label, "Undo: ") || w.History().Cursor != 0 {
		t.Fatalf("receipt %+v, cursor %d", receipt, w.History().Cursor)
	}
	if _, err := w.Redo(); err != nil {
		t.Fatal(err)
	}
	if readFile(t, path) != applied {
		t.Fatal("redo did not restore the applied bytes")
	}
	if w.Revision() != 4 {
		t.Fatalf("revision = %d, want 4", w.Revision())
	}
	if _, err := w.Redo(); !isRefusal(err, protocol.ReasonNotFound) {
		t.Fatalf("redo past the end: %v", err)
	}
}

func TestUndoAcrossOutsideEditIsRefused(t *testing.T) {
	dir := bonusModule(t)
	path := filepath.Join(dir, "bonus.go")
	w := open(t, dir)
	if _, err := w.Apply(addFinanceRequired); err != nil {
		t.Fatal(err)
	}
	applied := readFile(t, path)
	writeFile(t, path, applied+"\n// Edited elsewhere.\n")
	history := waitForEntries(t, w, 2)
	if history.Entries[0].CanUndo() || !history.Entries[1].CanUndo() {
		t.Fatalf("undoable flags = %+v", history.Entries)
	}
	// The outside edit itself can be undone, which restores the bytes the
	// editor wrote. The editor's entry behind it cannot.
	if _, err := w.Undo(); err != nil {
		t.Fatal(err)
	}
	if readFile(t, path) != applied {
		t.Fatal("undoing the outside edit did not restore the applied bytes")
	}
	if _, err := w.Undo(); !isRefusal(err, protocol.ReasonConflict) {
		t.Fatalf("undo across an outside edit: %v", err)
	}
	if readFile(t, path) != applied {
		t.Fatal("a refused undo wrote")
	}
}

func TestRedoRefusedWhenFileChanged(t *testing.T) {
	dir := bonusModule(t)
	path := filepath.Join(dir, "bonus.go")
	w := open(t, dir)
	if _, err := w.Apply(addFinanceRequired); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Undo(); err != nil {
		t.Fatal(err)
	}
	// The outside edit lands as a new entry, which discards the redo.
	writeFile(t, path, readFile(t, path)+"\n// Edited elsewhere.\n")
	if _, err := w.Redo(); !isRefusal(err, protocol.ReasonNotFound) {
		t.Fatalf("redo after an outside edit: %v", err)
	}
}

func TestKeystrokesMergePerRule(t *testing.T) {
	dir := bonusModule(t)
	w := open(t, dir)
	clock := time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC)
	w.now = func() time.Time { return clock }
	typeInto := func(rule, old, new string) {
		t.Helper()
		var r protocol.Rule
		for _, candidate := range w.Model().Rules {
			if candidate.ID == rule {
				r = candidate
			}
		}
		text := strings.Replace(r.Source, old, new, 1)
		if text == r.Source {
			t.Fatalf("%s does not contain %q", rule, old)
		}
		if _, err := w.Apply(protocol.Op{Op: protocol.OpReplaceSource, Rule: rule, Text: text, Base: r.SourceHash}); err != nil {
			t.Fatal(err)
		}
	}
	typeInto("TenureEligible", ">= 12", ">= 2")
	clock = clock.Add(time.Second)
	typeInto("TenureEligible", ">= 2", ">= 24")
	if n := len(w.History().Entries); n != 1 {
		t.Fatalf("keystrokes within the window made %d entries", n)
	}
	clock = clock.Add(3 * time.Second)
	typeInto("TenureEligible", ">= 24", ">= 4")
	if n := len(w.History().Entries); n != 2 {
		t.Fatalf("a keystroke after the window made %d entries, want 2", n)
	}
	typeInto("ConductClear", "!disciplinaryHold", "!(disciplinaryHold)")
	typeInto("TenureEligible", ">= 4", ">= 40")
	if n := len(w.History().Entries); n != 4 {
		t.Fatalf("keystrokes in another rule merged: %d entries, want 4", n)
	}
	// Undoing the merged first entry restores the bytes before its first
	// keystroke.
	for range 4 {
		if _, err := w.Undo(); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.Contains(readFile(t, filepath.Join(dir, "bonus.go")), ">= 12") {
		t.Fatal("undo did not restore the original threshold")
	}
}

func TestBrokenFileKeepsItsRules(t *testing.T) {
	dir := bonusModule(t)
	w := open(t, dir)
	rules := len(w.Model().Rules)
	path := filepath.Join(dir, "bonus.go")
	writeFile(t, path, strings.Replace(readFile(t, path), "return tenureMonths >= 12", "return tenureMonths >=", 1))
	event, _ := waitFor(t, w, 5*time.Second, func(e Event) bool { return e.Model != nil })
	model := event.Model
	if len(model.Rules) != rules {
		t.Fatalf("rules = %d, want the %d last parsed", len(model.Rules), rules)
	}
	var file protocol.SourceFile
	for _, f := range model.Files {
		if f.Path == "bonus.go" {
			file = f
		}
	}
	if file.State != protocol.FileSyntaxError || file.Problem == nil || file.Problem.File != "bonus.go" || file.Problem.Line == 0 {
		t.Fatalf("bonus.go = %+v", file)
	}
	if _, err := w.Apply(addFinanceRequired); !isRefusal(err, protocol.ReasonSyntaxError) {
		t.Fatalf("operation on the broken file: %v", err)
	}
	if _, err := w.Apply(protocol.Op{Op: protocol.OpAddInput, Fact: "bonusYear", Type: "uint16"}); err != nil {
		t.Fatalf("operation on another file: %v", err)
	}
}

func TestSymbolicLinkIsNeverWritten(t *testing.T) {
	dir := bonusModule(t)
	w := open(t, dir)
	path := filepath.Join(dir, "bonus.go")
	outside := filepath.Join(t.TempDir(), "bonus.go")
	original := readFile(t, path)
	writeFile(t, outside, original)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Apply(addFinanceRequired); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("apply through a symbolic link: %v", err)
	}
	if readFile(t, outside) != original {
		t.Fatal("the link's target was written")
	}
	if info, err := os.Lstat(path); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the link was replaced")
	}
}

func TestOnlyRuleSourceFilesAreWritable(t *testing.T) {
	w := open(t, bonusModule(t))
	op := protocol.Op{Op: protocol.OpReplaceSource}
	for _, path := range []string{"../outside.go", "sub/rules.go", "zz_infergo_gen.go", "notes.txt", ".hidden.go", filepath.Join(w.Dir(), "bonus.go")} {
		_, err := w.verifyLocked(op, source.Result{Files: source.Files{path: []byte("package bonus\n")}})
		if err == nil || !strings.Contains(err.Error(), "refusing to write") {
			t.Errorf("%s: %v", path, err)
		}
	}
}

func TestSlowConsumerDoesNotBlockWrites(t *testing.T) {
	w := open(t, bonusModule(t))
	done := make(chan error)
	go func() {
		for range 3 {
			if _, err := w.Apply(addFinanceRequired); err != nil {
				done <- err
				return
			}
			if _, err := w.Undo(); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("writes blocked on an unread event channel")
	}
	// The consumer then catches up on the newest state, skipping steps: at
	// most the event the pump held while the writes went on comes first.
	count := 0
	waitFor(t, w, 5*time.Second, func(e Event) bool {
		count++
		return e.Model != nil && e.Model.Revision == 7 && e.History != nil && e.History.Cursor == 0
	})
	if count > 2 {
		t.Fatalf("the consumer received %d events for six writes it fell behind on", count)
	}
}

func TestWriteEvaluatorRefusesStaleRevision(t *testing.T) {
	dir := bonusModule(t)
	w := open(t, dir)
	if _, err := w.WriteEvaluator(0, []byte("package bonus\n")); !errors.Is(err, ErrStale) {
		t.Fatalf("stale revision: %v", err)
	}
	if _, err := w.WriteEvaluator(1, []byte("package bonus\n")); err != nil {
		t.Fatal(err)
	}
	if readFile(t, filepath.Join(dir, "zz_infergo_gen.go")) != "package bonus\n" {
		t.Fatal("evaluator not written")
	}
}

func TestCountLines(t *testing.T) {
	for _, test := range []struct {
		before, after  string
		added, removed int
	}{
		{"", "", 0, 0},
		{"a\nb\n", "a\nb\n", 0, 0},
		{"a\nb\n", "a\nx\nb\n", 1, 0},
		{"a\nb\nc\n", "a\nc\n", 0, 1},
		{"a\nb\nc\n", "a\nB\nc\n", 1, 1},
		{"", "a\nb\n", 2, 0},
		{"a\nb\nc\nd\n", "b\na\nd\nc\n", 2, 2},
	} {
		added, removed := countLines([]byte(test.before), []byte(test.after))
		if added != test.added || removed != test.removed {
			t.Errorf("countLines(%q, %q) = %d, %d; want %d, %d", test.before, test.after, added, removed, test.added, test.removed)
		}
	}
}

// isRefusal reports whether err is a refusal with the reason.
func isRefusal(err error, reason string) bool {
	refusal, ok := protocol.AsRefusal(err)
	return ok && refusal.Reason == reason
}

func TestWatcherSeesNewAndDeletedFiles(t *testing.T) {
	dir := bonusModule(t)
	w := open(t, dir)
	extra := filepath.Join(dir, "extra.go")
	writeFile(t, extra, "package bonus\n\nconst extra = 1\n")
	history := waitForEntries(t, w, 1)
	if got := history.Entries[0].Files; len(got) != 1 || got[0] != (protocol.ReceiptFile{Path: "extra.go", Added: 3}) {
		t.Fatalf("new file entry = %+v", got)
	}
	// The evaluator and files the go tool skips are not source.
	writeFile(t, filepath.Join(dir, "zz_infergo_gen.go"), "package bonus\n")
	writeFile(t, filepath.Join(dir, ".scratch.go"), "package bonus\n")
	if err := os.Remove(extra); err != nil {
		t.Fatal(err)
	}
	history = waitForEntries(t, w, 2)
	if got := sources(history); got != "disk:extra.go disk:extra.go" || history.Entries[1].Files[0].Removed != 3 {
		t.Fatalf("history = %s %+v", got, history.Entries[1])
	}
	// Undoing the deletion brings the file back.
	if _, err := w.Undo(); err != nil {
		t.Fatal(err)
	}
	if readFile(t, extra) != "package bonus\n\nconst extra = 1\n" {
		t.Fatal("undo did not restore the deleted file")
	}
}
