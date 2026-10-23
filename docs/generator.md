# Generator reference

`infergen` reads one Go package, validates its selected rule functions, and writes
a typed evaluator into the same directory. This reference covers the CLI in
[cmd/infergen](../cmd/infergen/main.go).

## Run the generator

From a ruleset directory in a module that depends on Infergo:

```sh
go run github.com/vichr-vita/infergo/cmd/infergen --rules rules.go
```

To install a binary matching the version selected by that module:

```sh
go install github.com/vichr-vita/infergo/cmd/infergen
```

The executable goes to `GOBIN`, or the Go binary directory under `GOPATH` when
`GOBIN` is unset. Add that directory to your shell's `PATH` to run `infergen`
directly. Using `go run` in a generation directive avoids a separate binary
installation and uses the module's selected dependency version.

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
| `--config` | `INFERGEN_CONFIG` | See below. | Discover `infergen.*` in the current directory. |
| `-h`, `--help` | None. | None. | Print help without loading a ruleset or configuration. |

The CLI accepts no positional arguments. Use two dashes for long flags. Older
spellings such as `-rules` and `-out` are not supported.

Select multiple files using a comma-separated list or repeated flags:

```sh
infergen --rules rates.go,awards.go
infergen --rules rates.go --rules awards.go
```

Whitespace around file names is trimmed. Blank entries and duplicate paths are
errors. `--inputs` and `--outputs` name types in the current package, not file
paths or qualified names from another package.

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

Then run `infergen` with no flags. Only `rules` is required when using the default
contract names and output file.

To select a file elsewhere:

```sh
infergen --config ../config/bonus.yaml
```

Or set the configuration path through the environment:

```sh
INFERGEN_CONFIG=../config/bonus.yaml infergen
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
INFERGEN_RULES=rates.go,awards.go INFERGEN_OUT=generated.go infergen
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

The loader overlays the configured generated file with a package-only source
file. This lets it regenerate absent or stale output. All remaining non-test
package source must type-check without the generated declarations. Keep callers
of `Evaluate` in another package or in tests.

## Generated declarations

The output contains:

- A generated-code header and the ruleset's package declaration.
- An unexported `_infergoPlan`, built once during package initialization.
- An exported `Evaluate` function using your selected input and output types.
- Per-evaluation typed fact storage and direct calls to included rules.

`Evaluate` and `_infergoPlan` are reserved package names. A different `--out`
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

## Writes and failures

On success, the CLI writes a temporary file in the output directory, sets its
mode to `0644`, closes it, and renames it over the destination. It prints no
success message. The destination is replaced, so choose a file reserved for
generated code.

Generation or temporary-write failures leave an existing output untouched.
Errors go to standard error with an `infergen:` prefix, and the process exits
with status 1. Many declaration errors include source locations; config and path
errors may not. See [Troubleshooting](troubleshooting.md).

## Keep generation reproducible

Record the generator dependency in `go.mod` and `go.sum`. Use a generation
directive that runs that selected version, and regenerate after changes to rule
signatures, contract mappings, file selection, or generator version. Rule-body
changes need no graph regeneration when signatures remain unchanged.

Commit the generated file alongside its source, as this repository does. This
allows consumers to build without invoking the generator. In CI, regenerate and
check that the committed file remains unchanged. The [development
guide](../CONTRIBUTING.md#verify-a-change) gives commands for this repository.
