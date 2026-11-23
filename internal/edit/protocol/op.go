package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Names of the operations, the values of Op.Op.
const (
	OpAddRead        = "add_read"
	OpRemoveRead     = "remove_read"
	OpAddRule        = "add_rule"
	OpDeleteRule     = "delete_rule"
	OpRenameRule     = "rename_rule"
	OpRenameFact     = "rename_fact"
	OpSetRequirement = "set_requirement"
	OpAddProduce     = "add_produce"
	OpRemoveProduce  = "remove_produce"
	OpSetType        = "set_type"
	OpAddInput       = "add_input"
	OpRemoveInput    = "remove_input"
	OpSetRequested   = "set_requested"
	OpReplaceSource  = "replace_source"
)

// Op is one named gesture. Op names the operation, and the other fields are
// the arguments that operation uses. Validate lists which are required.
//
//	add_read         Rule, Fact, Type
//	remove_read      Rule, Fact
//	add_rule         Name, Produces (at least one), Reads, After
//	delete_rule      Rule
//	rename_rule      Rule, To
//	rename_fact      Fact, To, Rule (optional)
//	set_requirement  Rule, Text
//	add_produce      Rule, Fact, Type
//	remove_produce   Rule, Fact
//	set_type         Rule, Fact, Type
//	add_input        Fact, Type
//	remove_input     Fact
//	set_requested    Fact, Requested
//	replace_source   Rule, Text, Base, Format
//
// Rule names the rule function. Fact names a fact. For rename_fact, a Rule
// restricts the rename to that rule's own result and the uses in its body, which
// is how a fact with two producers gets one of them renamed. For add_rule, Name is the
// new rule's name and After the rule it follows, or empty for the end of the
// first rule file. Text is the new requirement or declaration source. Base is
// the hash of the declaration the text started from. Format asks the server to
// gofmt the declaration and fix imports, as the page does on blur and Ctrl+S.
// Without it the server writes the text as typed if the file still parses.
type Op struct {
	Op        string `json:"op"`
	Rule      string `json:"rule,omitempty"`
	Fact      string `json:"fact,omitempty"`
	Type      string `json:"type,omitempty"`
	Name      string `json:"name,omitempty"`
	To        string `json:"to,omitempty"`
	Text      string `json:"text,omitempty"`
	Base      string `json:"base,omitempty"`
	After     string `json:"after,omitempty"`
	Reads     []Fact `json:"reads,omitempty"`
	Produces  []Fact `json:"produces,omitempty"`
	Requested *bool  `json:"requested,omitempty"`
	Format    bool   `json:"format,omitempty"`
}

// MarshalJSON encodes add_rule with reads and produces always present as
// arrays, since the page's type requires them. Other operations omit empty
// arguments.
func (o Op) MarshalJSON() ([]byte, error) {
	type plain Op
	if o.Op != OpAddRule {
		return json.Marshal(plain(o))
	}
	return json.Marshal(struct {
		plain
		Reads    []Fact `json:"reads"`
		Produces []Fact `json:"produces"`
	}{plain(o), nonNil(o.Reads), nonNil(o.Produces)})
}

// required lists, per operation, the arguments Validate insists on.
var required = map[string][]string{
	OpAddRead:        {"rule", "fact", "type"},
	OpRemoveRead:     {"rule", "fact"},
	OpAddRule:        {"name", "produces"},
	OpDeleteRule:     {"rule"},
	OpRenameRule:     {"rule", "to"},
	OpRenameFact:     {"fact", "to"},
	OpSetRequirement: {"rule", "text"},
	OpAddProduce:     {"rule", "fact", "type"},
	OpRemoveProduce:  {"rule", "fact"},
	OpSetType:        {"rule", "fact", "type"},
	OpAddInput:       {"fact", "type"},
	OpRemoveInput:    {"fact"},
	OpSetRequested:   {"fact", "requested"},
	OpReplaceSource:  {"rule", "text", "base"},
}

// Validate checks that the operation name is known and that every argument it
// requires is present. It does not look at the ruleset, so a rule or fact that
// does not exist is the rewriter's refusal, not a validation error.
func (o Op) Validate() error {
	need, ok := required[o.Op]
	if !ok {
		return fmt.Errorf("unknown operation %q", o.Op)
	}
	var missing []string
	for _, name := range need {
		if !o.has(name) {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("operation %q is missing %v", o.Op, missing)
	}
	if o.Op == OpAddRule {
		for _, f := range append(append([]Fact(nil), o.Reads...), o.Produces...) {
			if f.Name == "" || f.Type == "" {
				return fmt.Errorf("operation %q has a fact without a name or type", o.Op)
			}
		}
	}
	return nil
}

// has reports whether the argument with the given JSON name is set.
func (o Op) has(name string) bool {
	switch name {
	case "rule":
		return o.Rule != ""
	case "fact":
		return o.Fact != ""
	case "type":
		return o.Type != ""
	case "name":
		return o.Name != ""
	case "to":
		return o.To != ""
	case "text":
		return o.Text != ""
	case "base":
		return o.Base != ""
	case "produces":
		return len(o.Produces) > 0
	case "requested":
		return o.Requested != nil
	}
	return false
}

// AsRefusal reports whether err is or wraps a Refusal and returns it.
func AsRefusal(err error) (Refusal, bool) {
	var refusal Refusal
	ok := errors.As(err, &refusal)
	return refusal, ok
}
