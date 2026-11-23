package workspace

import (
	"fmt"

	"golang.org/x/tools/go/packages"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
	"github.com/vichr-vita/infergo/internal/edit/source"
)

// applyOp runs op through the rewriter. An operation that needs type
// information loads the package and its tests from dir, which must hold the
// same bytes as files. A panic in the rewriter comes back as an error, so one
// bad input cannot end the editor session.
func applyOp(dir string, files source.Files, config source.Config, op protocol.Op) (result source.Result, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result, err = source.Result{}, fmt.Errorf("the rewriter failed on %s: %v", op.Op, recovered)
		}
	}()
	if !source.NeedsTypes(op) {
		return source.Apply(files, config, op)
	}
	pkgs, err := packages.Load(&packages.Config{Mode: source.LoadMode, Dir: dir, Tests: true}, ".")
	if err != nil {
		return source.Result{}, fmt.Errorf("load the ruleset package: %w", err)
	}
	return source.ApplyTyped(pkgs, files, config, op)
}

// parse builds the model, returning a panic in the parser as an error.
func parse(files source.Files, config source.Config) (model protocol.Model, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("the source model failed: %v", recovered)
		}
	}()
	return source.Parse(files, config), nil
}
