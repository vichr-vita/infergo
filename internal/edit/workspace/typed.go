package workspace

import (
	"github.com/vichr-vita/infergo/internal/edit/protocol"
	"github.com/vichr-vita/infergo/internal/edit/source"
)

// applyOp runs op through the rewriter. TEMPORARY until workstream B lands
// NeedsTypes, LoadMode, and the slice form of ApplyTyped.
func applyOp(dir string, files source.Files, config source.Config, op protocol.Op) (source.Result, error) {
	return source.Apply(files, config, op)
}
