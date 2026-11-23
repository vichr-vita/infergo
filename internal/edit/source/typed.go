package source

import (
	"golang.org/x/tools/go/packages"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// LoadMode is what ApplyTyped needs from go/packages. Load the ruleset
// directory with this mode and Tests set to true.
const LoadMode = packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes | packages.NeedTypesInfo

// ApplyTyped performs an operation that needs type information, rename_fact
// or rename_rule. pkgs is the ruleset directory loaded with LoadMode and Tests
// set, and files must match what was on disk when it was loaded. Refusals work
// as in Apply.
func ApplyTyped(pkgs []*packages.Package, files Files, config Config, op protocol.Op) (Result, error) {
	return Result{}, refuse(protocol.ReasonUnsupported, "Renaming is not implemented yet.")
}
