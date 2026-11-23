package source

import (
	"bytes"
	"go/ast"
	"strings"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// Parameter and result lists follow four rules. A new field is appended after
// the field before it with ", name type", or on its own line when the list is
// written one field per line with a trailing comma. A removed field takes one
// adjacent comma with it. In a field that declares several names, such as
// "a, b int", only the name is added or removed. A comment where the edit
// would land refuses the edit, because moving it could change what it
// describes.

// commentRefusal is the refusal for an edit that would land on a comment.
func commentRefusal(rule string) error {
	return refuse(protocol.ReasonUnsupported, "A comment sits where this edit to %s would land. Make the change in the code pane.", rule)
}

// insertField inserts "name typ" into list so that it becomes field number
// index. The list must have parentheses. rule names the function for refusals.
func (fe *fileEdit) insertField(list *ast.FieldList, index int, name, typ, rule string) error {
	f := fe.file
	src := f.src
	if len(list.List) == 0 {
		open, close := f.offset(list.Opening)+1, f.offset(list.Closing)
		if f.commentIn(open, close) {
			return commentRefusal(rule)
		}
		fe.replace(open, close, name+" "+typ)
		return nil
	}
	if index == 0 {
		first := list.List[0]
		open, start := f.offset(list.Opening)+1, f.offset(first.Pos())
		if f.commentIn(open, start) {
			return commentRefusal(rule)
		}
		if f.line(open) != f.line(start) {
			at := lineStart(src, start)
			fe.replace(at, at, indentOf(src, start)+name+" "+typ+",\n")
		} else {
			fe.replace(start, start, name+" "+typ+", ")
		}
		return nil
	}
	prev := list.List[index-1]
	prevEnd := f.offset(prev.End())
	boundary := f.offset(list.Closing)
	if index < len(list.List) {
		boundary = f.offset(list.List[index].Pos())
	}
	if len(prev.Names) > 1 && f.text(prev.Type) == typ {
		lastName := prev.Names[len(prev.Names)-1]
		at := f.offset(lastName.End())
		if f.commentIn(at, f.offset(prev.Type.Pos())) {
			return commentRefusal(rule)
		}
		fe.replace(at, at, ", "+name)
		return nil
	}
	if f.commentIn(prevEnd, boundary) {
		return commentRefusal(rule)
	}
	comma := bytes.IndexByte(src[prevEnd:boundary], ',')
	if comma >= 0 && f.line(prevEnd) != f.line(boundary) {
		at := prevEnd + comma + 1
		fe.replace(at, at, "\n"+indentOf(src, f.offset(prev.Pos()))+name+" "+typ+",")
		return nil
	}
	fe.replace(prevEnd, prevEnd, ", "+name+" "+typ)
	return nil
}

// removeName removes name number nameIndex of field number fieldIndex from
// list, taking one adjacent comma. A field left with no names disappears.
func (fe *fileEdit) removeName(list *ast.FieldList, fieldIndex, nameIndex int, rule string) error {
	f := fe.file
	field := list.List[fieldIndex]
	var start, end int
	switch {
	case len(field.Names) > 1 && nameIndex > 0:
		start, end = f.offset(field.Names[nameIndex-1].End()), f.offset(field.Names[nameIndex].End())
	case len(field.Names) > 1:
		start, end = f.offset(field.Names[0].Pos()), f.offset(field.Names[1].Pos())
	case len(list.List) == 1:
		start, end = f.offset(list.Opening)+1, f.offset(list.Closing)
	case fieldIndex < len(list.List)-1:
		start, end = f.offset(field.Pos()), f.offset(list.List[fieldIndex+1].Pos())
	default:
		start, end = f.offset(list.List[fieldIndex-1].End()), f.offset(field.End())
	}
	if f.commentIn(start, end) {
		return commentRefusal(rule)
	}
	fe.replace(start, end, "")
	return nil
}

// setFieldType gives name number nameIndex of a field the type typ. A field
// declaring several names is split so the other names keep their type.
func (fe *fileEdit) setFieldType(field *ast.Field, nameIndex int, typ, rule string) error {
	f := fe.file
	if len(field.Names) <= 1 {
		fe.replace(f.offset(field.Type.Pos()), f.offset(field.Type.End()), typ)
		return nil
	}
	start, end := f.offset(field.Pos()), f.offset(field.End())
	if f.commentIn(start, end) {
		return commentRefusal(rule)
	}
	old := f.text(field.Type)
	parts := make([]string, len(field.Names))
	for i, name := range field.Names {
		t := old
		if i == nameIndex {
			t = typ
		}
		parts[i] = name.Name + " " + t
	}
	fe.replace(start, end, strings.Join(parts, ", "))
	return nil
}

// findName locates a named field in a list, returning the field and name
// indexes, or false.
func findName(list *ast.FieldList, name string) (int, int, bool) {
	if list == nil {
		return 0, 0, false
	}
	for i, field := range list.List {
		for j, n := range field.Names {
			if n.Name == name {
				return i, j, true
			}
		}
	}
	return 0, 0, false
}
