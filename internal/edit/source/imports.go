package source

import (
	"go/ast"
	"go/parser"
	"go/token"
	"maps"
	"slices"
	"strconv"
	"strings"
)

// Import fixing edits import declarations as byte replacements, like every
// other rewrite. It knows package names only for the standard library, from
// standardPackages, so it never loads anything from disk: it adds only
// standard imports, and removes only imports whose name it is sure of, which
// are standard or explicitly named ones.

// addImport adds an import of importPath to the file. It joins the first
// parenthesized import declaration, placed among its standard imports so
// gofmt sorts it into that group. Without one it adds a declaration after the
// last import, or after the package clause.
func (fe *fileEdit) addImport(importPath string) {
	f := fe.file
	line := strconv.Quote(importPath)
	lastImport := -1
	for i, decl := range f.syntax.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.IMPORT {
			continue
		}
		lastImport = i
		if !gen.Lparen.IsValid() {
			continue
		}
		fe.touch(i, "", "")
		for _, s := range gen.Specs {
			spec := s.(*ast.ImportSpec)
			p, _ := strconv.Unquote(spec.Path.Value)
			if _, standard := standardPackages[p]; standard && f.line(f.offset(spec.Pos())) != f.line(f.offset(gen.Lparen)) {
				at := lineStart(f.src, f.offset(spec.Pos()))
				fe.replace(at, at, indentOf(f.src, f.offset(spec.Pos()))+line+"\n")
				return
			}
		}
		at := f.offset(gen.Lparen) + 1
		fe.replace(at, at, "\n\t"+line)
		return
	}
	if lastImport >= 0 {
		at := f.offset(f.syntax.Decls[lastImport].End())
		fe.replace(at, at, "\nimport "+line)
		fe.insertDecl(lastImport, "")
		return
	}
	at := f.offset(f.syntax.Name.End())
	fe.replace(at, at, "\n\nimport "+line)
	fe.insertDecl(-1, "")
}

// removeImports removes the given import specs. A declaration that loses all
// its specs is deleted. A spec is removed with its whole line when it is alone
// on that line.
func (fe *fileEdit) removeImports(remove []*ast.ImportSpec) {
	f := fe.file
	for i, decl := range f.syntax.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.IMPORT {
			continue
		}
		var gone []*ast.ImportSpec
		for _, s := range gen.Specs {
			if slices.Contains(remove, s.(*ast.ImportSpec)) {
				gone = append(gone, s.(*ast.ImportSpec))
			}
		}
		if len(gone) == 0 {
			continue
		}
		if len(gone) == len(gen.Specs) {
			fe.deleteDecl(i, "")
			continue
		}
		fe.touch(i, "", "")
		for _, spec := range gone {
			start, end := f.offset(spec.Pos()), f.offset(spec.End())
			if spec.Doc != nil {
				start = f.offset(spec.Doc.Pos())
			}
			if spec.Comment != nil {
				end = f.offset(spec.Comment.End())
			}
			ls, le := lineStart(f.src, start), lineEnd(f.src, end)
			if strings.TrimSpace(string(f.src[ls:start])) == "" && strings.TrimSpace(string(f.src[end:le])) == "" {
				start, end = ls, le
			} else if end < len(f.src) && f.src[end] == ';' {
				end++
			}
			fe.replace(start, end, "")
		}
	}
}

// qualifiers returns the identifiers used as package qualifiers in node, X in
// X.Sel, that the parser could not resolve within the file. Those are imported
// packages or package-level names declared in other files.
func qualifiers(node ast.Node) map[string]bool {
	used := make(map[string]bool)
	ast.Inspect(node, func(n ast.Node) bool {
		if selector, ok := n.(*ast.SelectorExpr); ok {
			if x, ok := selector.X.(*ast.Ident); ok && x.Obj == nil {
				used[x.Name] = true
			}
		}
		return true
	})
	return used
}

// fixImports updates the file's imports to match the qualifiers its bytes use
// once fe's other replacements are applied. With all set it adds missing
// standard imports and removes every import it is sure is unused, as goimports
// does. Otherwise it only removes imports that the replacements stopped using.
func (e *edit) fixImports(fe *fileEdit, all bool) error {
	f := fe.file
	spliced, err := fe.splice()
	if err != nil {
		return err
	}
	after, err := parser.ParseFile(token.NewFileSet(), f.path, spliced, parser.ParseComments)
	if err != nil {
		// finish reports the syntax error with its position.
		return nil
	}
	usedBefore, usedAfter := qualifiers(f.syntax), qualifiers(after)
	imported := make(map[string]bool)
	var remove []*ast.ImportSpec
	for _, spec := range f.syntax.Imports {
		p, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			continue
		}
		name, sure := standardPackages[p]
		if spec.Name != nil {
			name, sure = spec.Name.Name, true
		}
		if !sure {
			name = assumedName(p)
		}
		imported[name] = true
		if !sure || name == "_" || name == "." || p == "C" || usedAfter[name] {
			continue
		}
		if all || usedBefore[name] {
			remove = append(remove, spec)
		}
	}
	if len(remove) > 0 {
		fe.removeImports(remove)
	}
	if !all {
		return nil
	}
	declared := e.rs.packageNames(f)
	for _, name := range slices.Sorted(maps.Keys(usedAfter)) {
		if imported[name] || declared[name] {
			continue
		}
		if p, ok := standardPath(name); ok {
			fe.addImport(p)
		}
	}
	return nil
}

// standardPath returns the one standard package with the given name. A name
// two packages share, such as rand, is not resolved.
func standardPath(name string) (string, bool) {
	found := ""
	for p, n := range standardPackages {
		if n != name {
			continue
		}
		if found != "" {
			return "", false
		}
		found = p
	}
	return found, found != ""
}

// packageNames returns the package-level names declared in the ruleset
// package's files other than f, as seen from f: a non-test file does not see
// test files. With f nil it returns the names of every file in the package,
// test files included.
func (rs *ruleset) packageNames(f *parsedFile) map[string]bool {
	names := make(map[string]bool)
	for _, p := range rs.paths {
		other := rs.files[p]
		if other == f || other.syntax == nil || other.syntax.Name.Name != rs.pkgName || (f != nil && other.isTest() && !f.isTest()) {
			continue
		}
		for _, name := range declaredNames(other.syntax) {
			names[name] = true
		}
	}
	return names
}

// declaredNames lists the package-level names a file declares.
func declaredNames(file *ast.File) []string {
	var names []string
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if d.Recv == nil {
				names = append(names, d.Name.Name)
			}
		case *ast.GenDecl:
			for _, s := range d.Specs {
				switch spec := s.(type) {
				case *ast.TypeSpec:
					names = append(names, spec.Name.Name)
				case *ast.ValueSpec:
					for _, n := range spec.Names {
						names = append(names, n.Name)
					}
				}
			}
		}
	}
	return names
}
