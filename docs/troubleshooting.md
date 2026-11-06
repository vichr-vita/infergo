# Troubleshooting

Start by separating generation failures from evaluation failures. `infergen`
checks package declarations and graph structure. `Evaluate` runs already
generated code and reports failures from options, cancellation, or your rules.

## Generation fails

Run the generator from the ruleset directory. It reports the declaration and
graph errors it finds in one run, up to 10. Each one starts with the Go package
path and, when it has one, a location relative to that directory. Fixing them can
reveal more, because a rejected declaration can hide a related error. The
following messages are diagnostic fragments; file names, locations, and fact
names vary by ruleset.

> On v0.1.1, a run [stops at the first error](generator.md#v011-differences), which has no package prefix.

| Message or symptom | Cause and correction |
| --- | --- |
| `no such tool "infergen"` | In your module, run `go get -tool github.com/vichr-vita/infergo/cmd/infergen`. The Infergo repository has no tool dependency, so use `go run ./cmd/infergen` from its root or `go run ../../cmd/infergen` from `ruleset/bonus`. |
| `missing go.sum entry` | Run `go mod tidy`. `go mod download` alone does not record the generator's dependencies. If `go.mod` has no `tool` line for `infergen`, first run `go get -tool github.com/vichr-vita/infergo/cmd/infergen`. Unlike a plain `go get` of the command package, a tool dependency survives `go mod tidy`. |
| `rule files are required` | Supply `--rules`, `INFERGEN_RULES`, or a `rules` entry in a configuration file. There is no default rule file. |
| `inputs, outputs, rule files, and output file are required` | `--inputs`, `--outputs`, or `--out` is empty on the command line or in a config file. Supply a value, or remove the setting to use the default. |
| `rule file names must not be empty` | Remove blank entries, including a trailing comma or whitespace-only file name. |
| `unknown command "view"` or `unknown flag: --check` | The module uses v0.1.1, which lacks them. [Install `main`](generator.md#v011-differences). |
| `unknown flag` or `unknown shorthand flag` | Use the flags listed by `--help`. Long flags require two dashes. |
| `unknown command` or unexpected positional arguments | Pass file names through `--rules`, not as standalone arguments. |
| `read config:` | Check the selected path, file permissions, extension, and syntax. An explicit config file must exist. |
| `decode config:` | Check value types. Use a list of file names for `rules`, a boolean for `check`, and strings for the other settings. The value can come from an `INFERGEN_` variable. |
| `expected one ruleset package, found 0` | A separately built `infergen` ran outside a Go module. Run it from a ruleset directory inside a module. |
| `read ruleset package:` | The first rule file could not be read or its package clause could not be parsed. Check the path and Go syntax. |
| `load ruleset:` | Fix the reported Go package or dependency errors. Source may call the generated API through [stubs](generator.md#file-paths-and-package-loading), and those calls must match the generated signatures. Everything else must type-check. A parameter and a result cannot share a name, so `redeclared in this block` means a rule tried to consume its own output. |
| `missing parameter type` or `missing parameter name` | Go does not let named and unnamed results or parameters mix. Name the trailing error and the context parameter, or use `_`. |
| `undefined: Evaluate` while generating on v0.1.1 | That release cannot load source that calls the generated API. Move the call into a test file or another package, or [install `main`](generator.md#v011-differences). |
| `which this module cannot load` | Non-test source uses the generated API, and the module cannot load the Infergo runtime that the generated code imports. Run `go get github.com/vichr-vita/infergo`, then `go mod vendor` if the module has a vendor directory. Any `undefined: Evaluate` lines that follow come from the same cause. |
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
| `no input or rule produces fact` | Check spelling and case, input tags, and selection of the producer's file. A trailing `did you mean` names the closest known fact, if one is close. |
| `has multiple producers` | Keep one source for the fact. An external input also counts as a producer. |
| `has type ..., expected ...` | Use identical types at the producer, consumers, and contract fields. Defined types differ from their underlying types. |
| `rule dependency cycle` | Break the reported producer cycle. |
| `too many errors` | The run stopped reporting after 10 errors. Fix those and run the generator again. |
| `read generated file:` | `--check` could not read the existing output file. Fix its permissions and run again. This message has no package prefix. |
| `is reserved for generated code` | Rename the conflicting declaration. The generator reserves `Evaluate`, `EvaluateTrace`, `Ruleset`, `ViewerCase`, `ExportHTML`, and `_infergoPlan`. Remove an obsolete generated file only after checking it contains no hand-written code. |
| `rules must be in a separate package` | Move rules out of the `github.com/vichr-vita/infergo` runtime package. |

Configuration and path errors are described in the [generator
reference](generator.md). Declaration constraints are covered in
[Writing rulesets](rulesets.md).

## A generated evaluator is missing or stale

`go build` and `go test` do not generate code. Run the package's `go generate`
directive after changing signatures, rule bodies, doc comments, contracts, or
file selection.

Any compile error located in `zz_infergo_gen.go` means the generated file is
stale. A failed struct conversion means an input or output struct changed after
generation:

```text
./zz_infergo_gen.go:20:3: cannot convert Outputs{} (value of struct type Outputs) to type struct{Total int}
```

The struct at the end of the message is the shape from the last generation. A
renamed or removed rule gives `undefined: <RuleName>` with the old name. Run
`go generate` to fix either one. The generator ignores the stale file, so this
works while the package does not compile.

Renamed rule parameters and changed `fact` tags compile without any error and
keep the old wiring. To find them, run `INFERGEN_CHECK=true go generate ./...`,
which writes nothing. A stale package fails with
`example.com/rules: zz_infergo_gen.go is out of date; run go generate`, or
`is missing` when there is no output file. The `running "go": exit status 1` line
that follows gives the location of the package's directive. See [Keep generation
reproducible](generator.md#keep-generation-reproducible).

> On v0.1.1, this check [rewrites the file and exits 0](generator.md#v011-differences).

The generator ignores only the output path configured for this invocation. If
you changed `--out`, an old generated file may still define `Evaluate` and
`_infergoPlan`. Review and remove the obsolete generated file, then regenerate.

### `undefined: Evaluate` or `undefined: score.Evaluate` before the first generation

If `go build ./...` reports `undefined: score.Evaluate` (a caller in another
package) or `go vet` or `go test` reports `undefined: Evaluate` (a test file in
the ruleset package), and the generated file does not exist yet, `go generate`
has not run. Run `go generate ./...` from the module root, then build again.
`go build` on the ruleset package alone succeeds, because nothing in it calls
`Evaluate`.

## An unused rule fails generation

The generator validates every exported top-level function in selected rule
files before pruning unused branches. Fix the declaration, make it an
unexported helper, or move it into a file outside `--rules`. Selecting a smaller
output contract does not hide invalid selected rules.

## Viewing fails

`go tool infergen view` reports the same errors as generation, plus the following
messages. Those about an output path end with `choose another path with --html`.
See [View the rule graph](generator.md#view-the-rule-graph) for the rules behind
them.

| Message or symptom | Cause and correction |
| --- | --- |
| `does not end in .html or .htm` | Pass an `--html` path with one of those extensions. |
| `which is not an Infergo page` | `view` did not write the file at that path, and it will not replace it. Pass another `--html` path. |
| `which holds saved scenarios` | The file is a scenario report from `ExportHTML`, which `view` cannot recreate. Move it or pass another `--html` path. |
| `which is not a regular file` | The path is a symbolic link, a directory, or another special file. Pass another `--html` path. |
| `cannot check existing file` | The command could not inspect the existing file. Fix its permissions or pass another `--html` path. |
| `open <path>:` | `--open` could not start the platform's opener, such as `xdg-open`. The page stays at the printed path, so open it yourself. |
| `viewer case IDs must be unique and nonempty` | This one comes from `ExportHTML`. Give every `ViewerCase` a distinct, nonblank `ID`. |

## A rule does not run

> On v0.1.1, the generator [prints no warnings](generator.md#v011-differences).

First check whether any requested output depends on it. Unneeded rules do not
appear in the evaluator, and the generator warns about each one:

```text
infergen: example.com/rules: warning: rules.go:12:6: rule Orphan is not needed by any output and was left out
```

To keep the rule, consume its fact in a retained rule or add the fact to the
output contract. A matching warning, `input fact "region" is not used`, means the
same thing for an input. Warnings do not fail generation or `--check`. If the
rule is included, check for an upstream failure or cancellation. Inspect the
generated plan and direct calls when necessary.

A nil, false, or zero input does not suppress execution. If your application
expects value-based branching, handle the condition inside a rule or select a
different ruleset in application code.

## Evaluation fails or returns zero values

Check `err` before using the output struct. Any evaluation error discards all
returned outputs. Use `errors.As` to inspect `*infergo.RuleError` and `errors.Is`
to match the underlying cause. A negative `MaxParallel` fails before any work.

If `err` is nil, zero and nil output fields may be legitimate results. Test the
underlying rule directly and confirm the output field maps to the intended
fact. A stale evaluator can also leave outputs unexpectedly empty, because it keeps
the wiring from its last generation, so [check for
staleness](#a-generated-evaluator-is-missing-or-stale). With concurrent failures,
the observed rule name can vary between runs.

## NewPlan rejects a graph

These errors come from calling `infergo.NewPlan` directly, and each starts with
`infergo:`. See [Rule and NewPlan](runtime.md#rule-and-newplan).

| Message | Cause and correction |
| --- | --- |
| `must have a unique, nonempty name` | Give every `Rule` its own name. The message gives the rule's slice index. |
| `has invalid dependency` | Use only slice indices of the descriptor list in `DependsOn`. |
| `rule graph contains a cycle` | Remove the cycle, including any rule that depends on itself. |

## Cancellation does not return promptly

Infergo waits for started rule calls to finish. Pass the received context to
blocking I/O and check it during long computations. A rule that ignores
cancellation can hold up `Evaluate` after the caller's deadline. The engine does
not kill goroutines.

## A rule panics

> On v0.1.1, a parallel rule panic [crashes the process](generator.md#v011-differences).

Put `recover` on the goroutine that calls `Evaluate`. The recovered value is an
`*infergo.PanicError` at every `MaxParallel`. Its `Rule` field names the rule,
`Value` holds the original panic value, and `Stack` shows where the panic
happened. If existing code compares the recovered value directly, read `Value`
or use `errors.Is`.

Sequential execution has one exception. If a rule's deferred function panics
during `runtime.Goexit`, for example after `t.FailNow`, the goroutine exits after
`recover`.

The panic reaches the caller only after started rules return, so a rule that
ignores cancellation delays it. `EvaluateTrace` and `ExportHTML` panic the same
way and return no snapshot or HTML. See [Rule panics](runtime.md#rule-panics).

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
