package workspace

import (
	"bytes"
	"cmp"
	"slices"
	"time"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// fileChange is one file's bytes before and after a history entry. A file that
// did not exist on one side has the matching exists flag false.
type fileChange struct {
	path                      string
	before, after             []byte
	beforeExists, afterExists bool
}

// reversed swaps the two sides, turning a change into its undo.
func (c fileChange) reversed() fileChange {
	return fileChange{path: c.path, before: c.after, after: c.before, beforeExists: c.afterExists, afterExists: c.beforeExists}
}

// entry is one history entry: what the page sees, and the bytes undo and redo
// need, one fileChange per touched file in path order.
type entry struct {
	receipt protocol.Receipt
	files   []fileChange
}

// paths lists the entry's files for a message.
func (e entry) paths() string {
	names := make([]string, len(e.files))
	for i, change := range e.files {
		names[i] = change.path
	}
	return joinNames(names)
}

// journal is the undo history. Entries before cursor are applied. mergeKey and
// mergeTime describe the newest entry while further keystrokes of the same
// rule may still join it.
type journal struct {
	entries   []entry
	cursor    int
	nextID    int
	mergeKey  string
	mergeTime time.Time
}

// mergeKey returns the key under which consecutive entries of op merge, or ""
// for an operation that always gets its own entry. Only typing in the code
// pane merges, one entry per rule.
func mergeKey(op protocol.Op) string {
	if op.Op != protocol.OpReplaceSource {
		return ""
	}
	return op.Op + "\x00" + op.Rule
}

// record adds an entry for changes and returns its receipt. An entry with the
// same non-empty key as the newest entry, within mergeWindow of its last
// change and with nothing in between, merges into it instead. A new entry
// discards the undone entries after the cursor. An outside edit marks every
// older entry that touched one of its files as no longer undoable.
func (j *journal) record(changes []fileChange, label, source, note string, now time.Time, key string) protocol.Receipt {
	defer func() { j.mergeKey, j.mergeTime = key, now }()
	if key != "" && key == j.mergeKey && j.cursor == len(j.entries) && j.cursor > 0 && now.Sub(j.mergeTime) < mergeWindow {
		last := &j.entries[j.cursor-1]
		for _, change := range changes {
			i := slices.IndexFunc(last.files, func(c fileChange) bool { return c.path == change.path })
			if i < 0 {
				last.files = append(last.files, change)
				continue
			}
			last.files[i].after, last.files[i].afterExists = change.after, change.afterExists
		}
		slices.SortFunc(last.files, func(a, b fileChange) int { return cmp.Compare(a.path, b.path) })
		last.receipt.Label = label
		last.receipt.Time = now.UTC().Format(time.RFC3339)
		last.receipt.Files = receiptFiles(last.files)
		return last.receipt
	}
	j.entries = j.entries[:j.cursor]
	if source == protocol.SourceDisk {
		blocked := false
		for i := range j.entries {
			if j.entries[i].touchesAny(changes) {
				j.entries[i].receipt.Undoable = &blocked
			}
		}
	}
	j.nextID++
	e := entry{
		receipt: protocol.Receipt{
			ID: j.nextID, Label: label, Source: source, Files: receiptFiles(changes),
			Time: now.UTC().Format(time.RFC3339), Note: note,
		},
		files: changes,
	}
	j.entries = append(j.entries, e)
	j.cursor = len(j.entries)
	return e.receipt
}

// touchesAny reports whether the entry changed any of the files in changes.
func (e entry) touchesAny(changes []fileChange) bool {
	for _, mine := range e.files {
		for _, change := range changes {
			if mine.path == change.path {
				return true
			}
		}
	}
	return false
}

// history returns the journal as the page sees it, as a copy.
func (j *journal) history() protocol.History {
	entries := make([]protocol.Receipt, len(j.entries))
	for i, e := range j.entries {
		entries[i] = e.receipt
		entries[i].Files = slices.Clone(e.receipt.Files)
	}
	return protocol.History{Entries: entries, Cursor: j.cursor}
}

// receiptFiles counts the lines each change added and removed.
func receiptFiles(changes []fileChange) []protocol.ReceiptFile {
	files := make([]protocol.ReceiptFile, len(changes))
	for i, change := range changes {
		added, removed := countLines(change.before, change.after)
		files[i] = protocol.ReceiptFile{Path: change.path, Added: added, Removed: removed}
	}
	return files
}

// countLines returns how many lines a minimal line diff from before to after
// adds and removes. A changed line counts once in each.
func countLines(before, after []byte) (added, removed int) {
	a, b := splitLines(before), splitLines(after)
	for len(a) > 0 && len(b) > 0 && bytes.Equal(a[0], b[0]) {
		a, b = a[1:], b[1:]
	}
	for len(a) > 0 && len(b) > 0 && bytes.Equal(a[len(a)-1], b[len(b)-1]) {
		a, b = a[:len(a)-1], b[:len(b)-1]
	}
	common := longestCommonSubsequence(a, b)
	return len(b) - common, len(a) - common
}

// splitLines splits content into lines without their line endings.
func splitLines(content []byte) [][]byte {
	if len(content) == 0 {
		return nil
	}
	lines := bytes.Split(content, []byte("\n"))
	if len(lines[len(lines)-1]) == 0 {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// longestCommonSubsequence returns the length of the longest common
// subsequence of two line lists, in O(len(a)·len(b)) time and O(len(b)) space.
// Callers trim the common prefix and suffix first, so the lists are short.
func longestCommonSubsequence(a, b [][]byte) int {
	row := make([]int, len(b)+1)
	for i := range a {
		diagonal := 0
		for j := range b {
			above := row[j+1]
			if bytes.Equal(a[i], b[j]) {
				row[j+1] = diagonal + 1
			} else {
				row[j+1] = max(row[j+1], row[j])
			}
			diagonal = above
		}
	}
	return row[len(b)]
}
