# Troubleshooting

Start by separating generation failures from evaluation failures. `infergen`
checks package declarations and graph structure. `Evaluate` runs already
generated code and reports failures from options, cancellation, or your rules.

## Generation fails

Run the generator from the ruleset directory and inspect the first relevant
source location in its error. The following messages are diagnostic fragments;
file names, locations, and fact names vary by ruleset.

| Message or symptom | Cause and correction |
| --- | --- |
| `rule files are required` | Supply `--rules`, `INFERGEN_RULES`, or a `rules` entry in a configuration file. There is no default rule file. |
| `rule file names must not be empty` | Remove blank entries, including a trailing comma or whitespace-only file name. |
| `unknown flag` or `unknown shorthand flag` | Use the flags listed by `--help`. Long flags require two dashes. |
| `unknown command` or unexpected positional arguments | Pass file names through `--rules`, not as standalone arguments. |
| `read config:` | Check the selected path, file permissions, extension, and syntax. An explicit config file must exist. |
| `decode config:` | Check value types. Use a list of file names for `rules` and strings for the other settings. |
| `read ruleset package:` | The first rule file could not be read or its package clause could not be parsed. Check the path and Go syntax. |
| `load ruleset:` | Fix the reported Go package or dependency errors. Source must type-check with the configured generated file excluded. |
| `missing or excluded by build constraints` | Select an existing file in the active build and check build tags, `GOOS`, `GOARCH`, and `GOFLAGS`. |
| `must be a non-test .go file` | Keep rules and output in the current ruleset directory. Avoid `_test.go` paths and do not select the output as a rule file. |
| `is selected twice` | Remove duplicate paths from the rule selection. |
| `must name a struct type` or `must be a struct` | Make the configured input/output names refer to struct types declared in this package. |
| `must not be generic` | Use a non-generic contract type. |
| `fields must be exported and must not be embedded` | Use explicit exported fields in both contracts. |
| `invalid fact name` | Use a Go identifier other than `_`. Empty tags, `-`, and comma options are not accepted. |
| `maps multiple fields to fact` | Give each field in the contract a distinct fact mapping. |
| `cannot use the reserved error or context.Context types` | Use those types only for the rule's trailing error or first context parameter. |
| `requires named, non-error input facts` | Name every ordinary parameter, avoid `_`, and remove `error` inputs. |
| `requires named output facts` | Name every ordinary result and keep `context.Context` out of results. |
| `must place context.Context first` or `must place error last` | Move execution-control values to their supported positions. |
| `must produce at least one named fact` | Add an ordinary named result or move the function out of the selected rules. Error-only functions cannot be rules. |
| `must not be variadic or generic` | Use a non-generic rule with fixed parameters, and keep generic or variadic helpers outside rule selection. |
| `no input or rule produces fact` | Check spelling and case, input tags, and selection of the producer's file. |
| `has multiple producers` | Keep one source for the fact. An external input also counts as a producer. |
| `has type ..., expected ...` | Use identical types at the producer, consumers, and contract fields. Defined types differ from their underlying types. |
| `rule dependency cycle` | Break the reported producer cycle. A rule cannot consume its own output fact. |
| `is reserved for generated code` | Rename the conflicting declaration. The generator reserves `Evaluate`, `EvaluateTrace`, `Ruleset`, `ViewerCase`, `ExportHTML`, and `_infergoPlan`. Remove an obsolete generated file only after checking it contains no hand-written code. |
| `rules must be in a separate package` | Move rules out of the `github.com/vichr-vita/infergo` runtime package. |

Configuration and path errors are described in the [generator
reference](generator.md). Declaration constraints are covered in
[Writing rulesets](rulesets.md).

## A generated evaluator is missing or stale

`go build` and `go test` do not generate code. Run the package's `go generate`
directive after changing signatures, contracts, or file selection.

The generator ignores only the output path configured for this invocation. If
you changed `--out`, an old generated file may still define `Evaluate` and
`_infergoPlan`. Review and remove the obsolete generated file, then regenerate.

If a non-test file in the ruleset calls `Evaluate`, generation can fail with
`undefined: Evaluate` because loading deliberately hides the generated file.
Move that caller into another package or a test file. Leave contracts, rule
functions, and helpers compilable on their own.

For missing module checksum entries when running the generator, add its package
dependency from your application's module with
`go get github.com/vichr-vita/infergo/cmd/infergen`. Review the resulting module
changes. The command and generated runtime should use the same selected Infergo
module version.

## An unused rule fails generation

The generator validates every exported top-level function in selected rule
files before pruning unused branches. Fix the declaration, make it an
unexported helper, or move it into a file outside `--rules`. Selecting a smaller
output contract does not hide invalid selected rules.

## A rule does not run

First check whether any requested output depends on it. Unneeded rules do not
appear in the evaluator. If the rule is included, check for an upstream failure
or cancellation. Inspect the generated plan and direct calls when necessary.

A nil, false, or zero input does not suppress execution. If your application
expects value-based branching, handle the condition inside a rule or select a
different ruleset in application code.

## Evaluation fails or returns zero values

Check `err` before using the output struct. Any evaluation error discards all
returned outputs. Use `errors.As` to inspect `*infergo.RuleError` and `errors.Is`
to match the underlying cause. A negative `MaxParallel` fails before any work.

If `err` is nil, zero and nil output fields may be legitimate results. Test the
underlying rule directly and confirm the output field maps to the intended
fact. With concurrent failures, the observed rule name can vary between runs.

## Cancellation does not return promptly

Infergo waits for started rule calls to finish. Pass the received context to
blocking I/O and check it during long computations. A rule that ignores
cancellation can hold up `Evaluate` after the caller's deadline. The engine does
not kill goroutines or recover panics.

## Parallel execution races or is slower

Run `go test -race ./...` and inspect mutations of shared input references,
derived values, or package globals. The engine synchronizes producer completion
with consumers, but it cannot protect data that your code changes outside that
contract.

For performance, compare `MaxParallel: 1` with a small positive limit on your
real workload. Short rules or a mostly sequential graph may not justify worker
overhead. Limits apply per evaluation, so account for concurrent callers too.
See [Options](runtime.md#options).

## Report a reproducible problem

Include the generator command, `go version`, relevant build settings, config
values without secrets, a minimal set of rule and contract declarations, and the
full error. For runtime issues, include the input, concurrency limit, and whether
the race detector reports a problem. See the [development
guide](../CONTRIBUTING.md) for the relevant test packages.
