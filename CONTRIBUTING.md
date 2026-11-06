# Development guide

Use this guide to change the generator, runtime, example, or documentation.
The [architecture guide](docs/architecture.md) explains where each responsibility
lives. Ordinary Go commands work in this repository. The Makefile collects the
project's checks so that contributors and CI run the same ones, and it assumes
GNU Make.

## Set up a checkout

Install Go 1.26.0 or later, GNU Make, and Node 22, the version CI uses. The race
detector also needs a supported Go platform and the platform's C toolchain.

From a checkout, install the viewer's Node dependencies and run every check
that does not need a browser:

```sh
npm ci
make check
```

A change that touches only Go code can skip Node. Run `make check-go` instead,
which needs only Go and Make.

Generation rewrites the committed bonus evaluator from its declarations. It
does not contact a database or application service. Package loading and module
downloads may need access to Go module dependencies.

## Verify a change

Format Go files with `make fmt`, regenerate when needed with `make generate`,
and run:

```sh
make check
git diff --check
```

`make check` runs `make check-go` and `make check-viewer`. The Go checks verify
formatting, that `go.mod` is tidy, `go vet`, that the generated output is
current, and the tests with the race detector. The viewer check type-checks the
viewer and verifies that the committed bundle is current. `git diff --check`
depends on what is staged, so run it yourself.

Review changes to `ruleset/bonus/zz_infergo_gen.go` whenever you change emission
or the example's graph. Commit generated changes alongside their source. The
staleness check in `make check-go` writes nothing and fails if the generated
file differs from what the generator would produce.

Viewer changes also need the browser tests, which require Playwright browsers:

```sh
npx playwright install chromium webkit
make test-ui
```

Linux hosts may also need the browsers' system libraries. CI installs them with
`npx playwright install --with-deps chromium webkit`, which asks for `sudo`.
Where Playwright cannot install them, `npx playwright test --project=chromium`
runs the Chromium half, and CI still covers WebKit.

The CI workflow runs `make check` and `make test-ui`, which test the HTML viewer
in Chromium and WebKit, including narrow mobile widths. Follow the [viewer
development instructions](docs/visualization.md#maintain-the-viewer) when changing
the viewer. A docs-only change should also check relative links, keep Go blocks
gofmt clean, and compile any new complete Go examples.

## Choose the relevant tests

| Area | Command | Coverage |
| --- | --- | --- |
| Runtime | `go test -race .` | Dependency order, bounded concurrency, readiness, cancellation, failure cleanup, rule panics, `Goexit`, concurrent evaluations, invalid plans, snapshot formatting, and HTML export. |
| Generator | `go test ./internal/generate` | Generated-code compilation and execution, pruning, nil facts, imported and defined types, regeneration, stale contract guards, rejected declarations, multi-error reports, suggestions, and warnings. |
| CLI | `go test ./cmd/infergen` | Flags, config discovery, precedence, help, check mode, `view`, and preserving existing output on errors. |
| Bonus policy | `go test -race ./ruleset/bonus` | Fixed scenarios, arithmetic, boundaries, invalid values, and the runnable example. |
| Viewer | `make test-ui` | Browser behavior in `tests/ui/viewer.spec.cjs`, including saved scenarios, source inspection, search, zoom, and mobile layouts. |

Generator tests create temporary Go modules and compile the emitted source. The
main evaluator fixture runs its generated tests with `-race` as well. Keep tests
focused on externally observable behavior rather than a complete generated text
snapshot.

When changing a declaration rule, test both the diagnostic for invalid input and
a generated program that exercises valid behavior where appropriate. When
changing scheduling, test the ordering or cancellation contract involved. Use
synchronization to establish concurrency conditions instead of depending on
short sleeps or timing assumptions.

## Use a local checkout from another module

In a separate scratch application, initialize a module if needed, then replace
the dependency path. Substitute your checkout's absolute path:

```sh
go mod edit -replace=github.com/vichr-vita/infergo=/absolute/path/to/infergo
go get -tool github.com/vichr-vita/infergo/cmd/infergen
```

The replacement makes `go tool infergen` and the runtime use the local source. Use
`GOWORK=off` for commands in the scratch module if an enclosing Go workspace
would otherwise change dependency selection. Do not commit a machine-specific
replacement into a consumer intended to build elsewhere.

This workflow also lets you follow the [getting started
guide](docs/getting-started.md) against an unpublished change. Run the tutorial's
generation and test commands from the scratch module, not the Infergo repository.

## Change the generator safely

The CLI resolves configuration and owns file writes. The internal `Generate`
function returns formatted source without writing it. Keep that division so
validation failures cannot overwrite a working evaluator.

Preserve source locations in declaration diagnostics. Validate the complete
selected graph before pruning. Changes to emitted declarations should retain
the ability to regenerate when the old output is absent or stale.

Keep output deterministic for a fixed source and build environment. Avoid
timestamps or unsorted map iteration in generated text. Preserve typed fact
storage, direct calls, and publication only after a rule succeeds.

## Change the runtime safely

A plan is shared between evaluations, while readiness counters and facts belong
to each call. Avoid mutable execution state on `Plan`. Dependencies must count
producer rules once even when several facts come from that producer.

Failure and cancellation must signal running work and wait for it before return.
A rule panic follows the same cleanup and must reach the goroutine that called
`Run` at every limit. Independent rule completions must not block forever after
the coordinator stops receiving. Preserve the sequential path for limits zero
and one.

The public contract does not require a specific order among independent rules.
Tests should assert dependencies and bounds without creating an accidental
ordering promise.

## Maintain documentation

Use the [README](README.md) as the entry point. Keep detailed ruleset constraints
in [Writing rulesets](docs/rulesets.md), CLI settings in the [generator
reference](docs/generator.md), and execution semantics in the [runtime
reference](docs/runtime.md). Link to those pages rather than duplicating full
reference material.

Update examples and troubleshooting entries with behavior changes. Check links
when moving pages or renaming headings. Use Markdown that remains readable in
the repository; a documentation site is not required to use these guides.

## Submit changes

Existing commit subjects use conventional prefixes such as `feat:`. Keep change
titles short, explain the problem and resulting behavior, and report the tests
you ran. For a bug report, provide a minimal ruleset or plan that reproduces it.

Contributions are licensed under the [Apache License 2.0](LICENSE).
