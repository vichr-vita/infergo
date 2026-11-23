package source

import (
	"bytes"
	"cmp"
	"fmt"
	"go/format"
	"go/parser"
	"go/token"
	"slices"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// replacement swaps the bytes in [start, end) of a file's original source for
// text.
type replacement struct {
	start, end int
	text       string
}

// touchedDecl is an existing top-level declaration an operation changes or
// deletes. spec names the type spec inside a parenthesized type declaration.
type touchedDecl struct {
	index   int
	spec    string
	rule    string
	deleted bool
}

// insertedDecl is a new top-level declaration placed after the original
// declaration with index after, or before all of them when after is -1.
type insertedDecl struct {
	after int
	rule  string
}

// fileEdit collects the replacements for one file and the declarations they
// touch. All offsets are in the file's original bytes.
type fileEdit struct {
	file         *parsedFile
	replacements []replacement
	touched      []touchedDecl
	inserted     []insertedDecl
}

// replace records a replacement of [start, end) with text.
func (fe *fileEdit) replace(start, end int, text string) {
	fe.replacements = append(fe.replacements, replacement{start, end, text})
}

// touch records that the declaration at index changes.
func (fe *fileEdit) touch(index int, spec, rule string) {
	for _, t := range fe.touched {
		if t.index == index && t.spec == spec {
			return
		}
	}
	fe.touched = append(fe.touched, touchedDecl{index: index, spec: spec, rule: rule})
}

// deleteDecl removes the declaration at index together with its doc comment.
func (fe *fileEdit) deleteDecl(index int, rule string) {
	start, end := fe.file.declExtent(fe.file.syntax.Decls[index], "")
	fe.replace(start, end, "")
	for i, t := range fe.touched {
		if t.index == index {
			fe.touched[i].deleted = true
			return
		}
	}
	fe.touched = append(fe.touched, touchedDecl{index: index, rule: rule, deleted: true})
}

// insertDecl records that the replacements add a declaration after the
// original declaration with index after.
func (fe *fileEdit) insertDecl(after int, rule string) {
	fe.inserted = append(fe.inserted, insertedDecl{after: after, rule: rule})
}

// splice applies the replacements to the original bytes.
func (fe *fileEdit) splice() ([]byte, error) {
	sorted := slices.Clone(fe.replacements)
	slices.SortStableFunc(sorted, func(a, b replacement) int { return cmp.Compare(a.start, b.start) })
	src := fe.file.src
	var out bytes.Buffer
	last := 0
	for _, r := range sorted {
		if r.start < last || r.end < r.start || r.end > len(src) {
			return nil, fmt.Errorf("overlapping or invalid replacements in %s", fe.file.path)
		}
		out.Write(src[last:r.start])
		out.WriteString(r.text)
		last = r.end
	}
	out.Write(src[last:])
	return out.Bytes(), nil
}

// edit is one operation in progress: the replacements for each file it
// touches, and how the result is finished.
type edit struct {
	rs    *ruleset
	files map[string]*fileEdit
	order []string
	// raw writes the spliced bytes without formatting, for replace_source
	// without Format.
	raw bool
}

// newEdit starts an operation on the parsed ruleset.
func newEdit(rs *ruleset) *edit {
	return &edit{rs: rs, files: make(map[string]*fileEdit)}
}

// in returns the edit of a file, creating it on first use.
func (e *edit) in(f *parsedFile) *fileEdit {
	if fe, ok := e.files[f.path]; ok {
		return fe
	}
	fe := &fileEdit{file: f}
	e.files[f.path] = fe
	e.order = append(e.order, f.path)
	return fe
}

// finish splices, checks, and formats each touched file, and collects one
// change per declaration whose source differs.
func (e *edit) finish(label string) (Result, error) {
	result := Result{Files: Files{}, Label: label}
	for _, p := range e.order {
		fe := e.files[p]
		out, err := fe.splice()
		if err != nil {
			return Result{}, err
		}
		if _, err := parser.ParseFile(token.NewFileSet(), p, out, parser.ParseComments); err != nil {
			problem, _ := firstProblem(p, err)
			return Result{}, refuse(protocol.ReasonSyntaxError, "The edit would leave %s unparseable at line %d, column %d: %s.", p, problem.Line, problem.Column, problem.Message)
		}
		if !e.raw {
			if out, err = format.Source(out); err != nil {
				return Result{}, fmt.Errorf("format %s: %w", p, err)
			}
		}
		changes, err := fe.changes(out)
		if err != nil {
			return Result{}, err
		}
		result.Changes = append(result.Changes, changes...)
		if !bytes.Equal(out, fe.file.src) {
			result.Files[p] = out
		}
	}
	return result, nil
}

// changes pairs each touched or inserted declaration with its source in the
// new bytes. Declarations are matched by position in the file's declaration
// list, which formatting does not reorder.
func (fe *fileEdit) changes(out []byte) ([]protocol.Change, error) {
	after := parseFile(fe.file.path, out)
	if after.problem != nil {
		return nil, fmt.Errorf("%s does not parse after the edit: %s", fe.file.path, after.problem.Message)
	}
	type slot struct {
		old      int // index in the original declarations, or -1
		inserted int // index in fe.inserted, or -1
	}
	deleted := make(map[int]bool)
	for _, t := range fe.touched {
		if t.deleted {
			deleted[t.index] = true
		}
	}
	var slots []slot
	emitInserted := func(after int) {
		for i, ins := range fe.inserted {
			if ins.after == after {
				slots = append(slots, slot{old: -1, inserted: i})
			}
		}
	}
	emitInserted(-1)
	for i := range fe.file.syntax.Decls {
		if !deleted[i] {
			slots = append(slots, slot{old: i, inserted: -1})
		}
		emitInserted(i)
	}
	if len(slots) != len(after.syntax.Decls) {
		return nil, fmt.Errorf("%s has %d declarations after the edit, expected %d", fe.file.path, len(after.syntax.Decls), len(slots))
	}
	type positioned struct {
		at     int
		change protocol.Change
	}
	var found []positioned
	for _, t := range fe.touched {
		c := protocol.Change{File: fe.file.path, Rule: t.rule, Before: fe.file.declSource(t.index, t.spec)}
		at := -1
		if !t.deleted {
			at = slices.IndexFunc(slots, func(s slot) bool { return s.old == t.index })
			c.After = after.declSource(at, t.spec)
		}
		start, _ := fe.file.declExtent(fe.file.syntax.Decls[t.index], t.spec)
		found = append(found, positioned{at: start, change: c})
	}
	for i, ins := range fe.inserted {
		at := slices.IndexFunc(slots, func(s slot) bool { return s.inserted == i })
		c := protocol.Change{File: fe.file.path, Rule: ins.rule, After: after.declSource(at, "")}
		position := len(fe.file.src)
		if ins.after >= 0 {
			_, position = fe.file.declExtent(fe.file.syntax.Decls[ins.after], "")
		} else {
			position = 0
		}
		found = append(found, positioned{at: position, change: c})
	}
	slices.SortStableFunc(found, func(a, b positioned) int { return cmp.Compare(a.at, b.at) })
	var changes []protocol.Change
	for _, p := range found {
		if p.change.Before != p.change.After {
			changes = append(changes, p.change)
		}
	}
	return changes, nil
}

// lineStart returns the offset of the first byte of the line holding offset.
func lineStart(src []byte, offset int) int {
	return bytes.LastIndexByte(src[:offset], '\n') + 1
}

// lineEnd returns the offset just past the newline that ends the line holding
// offset, or len(src) on the last line.
func lineEnd(src []byte, offset int) int {
	i := bytes.IndexByte(src[offset:], '\n')
	if i < 0 {
		return len(src)
	}
	return offset + i + 1
}

// indentOf returns the leading whitespace of the line holding offset.
func indentOf(src []byte, offset int) string {
	start := lineStart(src, offset)
	end := start
	for end < len(src) && (src[end] == ' ' || src[end] == '\t') {
		end++
	}
	return string(src[start:end])
}

// commentIn reports whether a comment overlaps [start, end) of the file.
func (f *parsedFile) commentIn(start, end int) bool {
	for _, group := range f.syntax.Comments {
		for _, c := range group.List {
			s, e := f.offset(c.Pos()), f.offset(c.End())
			if s < end && e > start {
				return true
			}
		}
	}
	return false
}
