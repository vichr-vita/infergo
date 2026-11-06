# Generator reference

`infergen` reads one Go package, validates its selected rule functions, and writes
a typed evaluator into the same directory. This reference covers the CLI in
[cmd/infergen](../cmd/infergen/main.go).

## Run the generator

Record the generator as a tool dependency once, from your module root:

```sh
go get -tool github.com/vichr-vita/infergo/cmd/infergen
```

Then, from a ruleset directory in that module:

```sh
go tool infergen --rules rules.go
```

`go tool` builds `infergen` at the version in your `go.mod`, so the generator
and the runtime always match, and `go mod tidy` keeps the dependency. Use the
same command in a `//go:generate` directive. No binary is installed into
`GOBIN` or onto your `PATH`.

For work inside the Infergo repository, run `go run ./cmd/infergen --help` from
the root. The included bonus package uses `go run ../../cmd/infergen` in its
generation directive.

## Flags and defaults

| Flag | Environment variable | Config key | Default |
| --- | --- | --- | --- |
| `--rules` | `INFERGEN_RULES` | `rules` | None; required. |
| `--inputs` | `INFERGEN_INPUTS` | `inputs` | `Inputs` |
| `--outputs` | `INFERGEN_OUTPUTS` | `outputs` | `Outputs` |
| `--out` | `INFERGEN_OUT` | `out` | `zz_infergo_gen.go` |
| `--check` | `INFERGEN_CHECK` | `check` | `false`. See [Keep generation reproducible](#keep-generation-reproducible). |
| `--config` | `INFERGEN_CONFIG` | See below. | Discover `infergen.*` in the current directory. |
| `-h`, `--help` | None. | None. | Print help without loading a ruleset or configuration. |

The CLI accepts no positional arguments. Use two dashes for long flags. Older
spellings such as `-rules` and `-out` are not supported.

Select multiple files using a comma-separated list or repeated flags:

```sh
go tool infergen --rules rates.go,awards.go
go tool infergen --rules rates.go --rules awards.go
```

Whitespace around file names is trimmed. Blank entries and duplicate paths are
errors. `--inputs` and `--outputs` name a type declared in the current package,
not a file path or a qualified name such as `dep.In`. That type may be an alias
or a defined type of a struct from another package, for example
`type Inputs = dep.In`. See [Generated declarations](#generated-declarations) for
what such a contract gives up.

## Configuration files

The generator discovers an optional `infergen.*` file in the current directory
through Viper. YAML, TOML, and JSON are supported choices. Keep one discovered
configuration file per directory to avoid relying on format search order.

For example, `infergen.yaml` can contain:

```yaml
rules:
  - rates.go
  - awards.go
inputs: Inputs
outputs: Outputs
out: zz_infergo_gen.go
```

Then run `go tool infergen` with no flags. Only `rules` is required when using the default
contract names and output file.

To select a file elsewhere:

```sh
go tool infergen --config ../config/bonus.yaml
```

Or set the configuration path through the environment:

```sh
INFERGEN_CONFIG=../config/bonus.yaml go tool infergen
```

`--config` overrides `INFERGEN_CONFIG`. The config path is chosen before reading
the file; a `config` key inside a file does not select another file. A missing
automatically discovered file is allowed. A missing explicitly selected file or
malformed file is an error, even if flags supply the other settings.

## Environment and precedence

For generator settings, the precedence is:

1. Explicit command-line flags.
2. Nonempty `INFERGEN_` environment variables.
3. Configuration file values.
4. Flag defaults.

Use a comma-separated value for `INFERGEN_RULES`:

```sh
INFERGEN_RULES=rates.go,awards.go INFERGEN_OUT=generated.go go tool infergen
```

Empty environment variables are treated as unset. An explicit `--rules` list
replaces a lower-precedence list instead of extending it.

## File paths and package loading

The working directory is always the ruleset directory. Rule and output paths
are resolved against it, including when the config file lives elsewhere.
Absolute paths are allowed only when they still identify files in that directory.

| Path | Constraints |
| --- | --- |
| Rule file | Non-test `.go` file in the ruleset directory, distinct from the output. |
| Output file | Non-test `.go` file in the ruleset directory. |
| Config file | May live elsewhere; does not change the ruleset directory. |

There is no glob expansion inside the generator and no directory-recursive rule
selection. Pass explicit file names. Tests are excluded from package loading.
Build constraints, module configuration, and the active Go environment affect
which source files the loader sees. A selected file excluded by build constraints
is an error. There is no dedicated `--tags` option; use the Go build environment,
such as `GOFLAGS`, when needed.

The loader replaces the configured generated file with a package-only source
file, so it can regenerate absent or stale output. If the package doesn't
type-check that way, the loader tries again with stubs of `Evaluate`,
`EvaluateTrace`, `Ruleset`, `ViewerCase`, and `ExportHTML` in that file. This lets
non-test files in the ruleset package call the generated API. They must call it
correctly, because the stubs have the same signatures as the generated code.

## Generated declarations

The output contains:

- A generated-code header and the ruleset's package declaration.
- A struct conversion for each input and output contract whose fields are all
  declared in the ruleset package. It stops compiling if the contract's field
  names, types, or order change after generation.
- An unexported `_infergoPlan`, built once during package initialization.
- An exported `Evaluate` function using your selected input and output types.
- `Ruleset` metadata, `EvaluateTrace` diagnostic evaluation, and a typed
  `ViewerCase` alias with `ExportHTML` for the offline viewer. See the
  [visualization guide](visualization.md).
- Per-evaluation typed fact storage and direct calls to included rules.

`Evaluate`, `EvaluateTrace`, `Ruleset`, `ViewerCase`, `ExportHTML`, and
`_infergoPlan` are reserved package names. A different `--out`
does not create a second independently named evaluator. If you rename the output
file, remove the old generated file after confirming it contains only generated
code, then regenerate with the new configuration.

Rules are validated before pruning to the requested outputs. File selection
order does not determine execution order. The compiler sorts file paths and
imports, formats output with `go/format`, and produces reproducible bytes for
the same source, configuration, tool version, and build environment.

The generated file does not inherit build tags from rule files. If your ruleset
varies by platform or build tags, ensure the generated file and its referenced
rules are compiled together in every supported configuration. Separate packages
are often easier to maintain than several graph variants in one directory.

The contract conversions are fixed at generation time too. If a contract's fields
vary by build tag or platform, or an array length comes from a platform-dependent
constant, the conversion fails to compile on any configuration other than the one
that generated it.

A contract whose fields are declared in another package, such as
`type Inputs = dep.In` or `type Inputs dep.In`, gets no conversion, because those
fields can use types the ruleset package cannot name. Field changes in that
package do not break the build, so `--check` is the only protection for it.

## Writes and failures

When the generated source differs from the existing output, the CLI writes a
temporary file in the output directory, sets its mode to `0644`, closes it, and
renames it over the destination. It then prints one line to standard error:

```text
infergen: example.com/rules: updated zz_infergo_gen.go (4 rules)
```

If the content already matches, the CLI leaves the file alone and prints no such
line, so a generation that changes nothing is quiet. CRLF line endings in the
existing file don't count as a difference, here or with `--check`. A file the CLI
can't read counts as different, so it gets replaced. The destination is replaced,
so choose a file reserved for generated code. With `--check`, the CLI compares
instead and writes nothing.

Generation or temporary-write failures leave an existing output untouched.
Errors go to standard error with an `infergen:` prefix, and the process exits
with status 1. One run reports declaration and graph errors together in source
order. After 10 errors it prints `too many errors` and stops, as the Go compiler
does. A rejected declaration can hide a related error until you fix it. For
example, a rule with an unnamed `int` result hides a missing `typo int` parameter,
because that parameter might be meant to read the result. The run still fails,
and the next run reports what remains. Go package load and type-check failures
end the run on their own, because the rules can't be read until the package
compiles.

Each declaration, graph, and load error starts with the Go package path, followed
by a position relative to the ruleset directory, so `go generate ./...` output
shows which package failed. A missing fact gets a suggestion when a known fact
name is close, unless the rule's signature already declares that name:

```text
infergen: example.com/rules: rules.go:5:13: no input or rule produces fact "sed"; did you mean "seed"?
```

A compiler error block has no prefix of its own, because its `# <package>` heading
already names the package:

```text
infergen: load ruleset:
# example.com/rules
./rules.go:3:12: undefined: undefinedType
infergen: example.com/rules: load ruleset: rules.go:3:12: undefined: undefinedType
```

A position in a file outside the ruleset directory stays absolute, for example
when a contract field is declared in another package. Errors from before the
package loads, such as config and path errors, have no package prefix and may have
no position. One of them, `read ruleset package:`, prints the rule file's absolute
path.

A successful run can also print warnings to standard error. Warnings never change
the exit status, and `--check` prints them too:

```text
infergen: example.com/rules: warning: rules.go:4:2: input fact "region" is not used by any output or retained rule
infergen: example.com/rules: warning: rules.go:12:6: rule Orphan is not needed by any output and was left out
```

An input counts as unused when no retained rule consumes it and no output reads
it directly, so an input read only by a pruned rule gets a warning as well. See
[Troubleshooting](troubleshooting.md).

## Keep generation reproducible

Record the generator dependency in `go.mod` and `go.sum`. Use a generation
directive that runs that selected version, and regenerate after changes to rule
signatures, rule bodies, doc comments, contract mappings, file selection, or
generator version.

A rule-body change alters evaluator behavior at the next compile without
regeneration, because the generated code calls your function directly. The
generated `Ruleset` metadata embeds each rule's source and doc comment, though.
Until you regenerate, the viewer shows the old text and the check below fails.

The compiler catches some staleness. The contract conversions in the generated
file stop compiling when an input or output struct declared in the ruleset package
gains, loses, reorders, or retypes a field. Other changes still compile. Go types do not record parameter
names, so renaming a parameter to another fact of the same type keeps the old
wiring until you regenerate. Struct conversion ignores tags, so a changed `fact`
tag behaves the same way.

Check mode catches all of these. Commit the generated file alongside its source,
as this repository does, so that consumers can build without invoking the
generator. Then run this in CI:

```sh
INFERGEN_CHECK=true go generate ./...
```

The environment variable reaches every `infergen` process that `go generate`
starts, so each package keeps its directive unchanged. `--check` does the same
for a single run. Each process generates as usual, compares the result with the
existing output file, and writes nothing. It exits silently when the file is
current, apart from any warnings. When the file differs or is missing, it exits
with status 1 and an error that names the Go package and the file and tells the
reader to run `go generate`. The [development
guide](../CONTRIBUTING.md#verify-a-change) gives commands for this repository.
