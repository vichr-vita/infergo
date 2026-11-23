# Single definition of the project's checks, used by contributors and CI.
.DEFAULT_GOAL := check
.PHONY: check check-go check-viewer check-editor test-ui generate fmt help

# Everything that needs no browsers.
check: check-go check-viewer check-editor

# Needs only Go. Stops at the first failing step.
check-go:
	@unformatted=$$(gofmt -l .) || { echo "gofmt failed"; exit 1; }; \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt: these files need formatting (run make fmt):"; \
		echo "$$unformatted"; \
		exit 1; \
	fi
	go mod tidy -diff
	go vet ./...
	INFERGEN_CHECK=true go generate ./...
	go test -race ./...

# Needs Node and `npm ci`.
check-viewer:
	npm run check:viewer

# Needs Node and `npm ci`. Type-checks the editor page, verifies that the
# committed bundle is current (npm run build:editor rebuilds it), and runs its
# unit tests.
check-editor:
	npm run check:editor

# Needs Playwright browsers (npx playwright install chromium webkit) and Go.
# Runs the viewer tests and the editor tests, which start infergen edit.
test-ui:
	npm run test:ui

generate:
	go generate ./...

fmt:
	gofmt -w .

help:
	@echo "check         check-go, check-viewer, and check-editor (default)"
	@echo "check-go      format, tidy, vet, generator staleness, race tests"
	@echo "check-viewer  type-check and verify the viewer bundle"
	@echo "check-editor  type-check, verify the bundle, and unit-test the editor page"
	@echo "test-ui       Playwright tests for the viewer and the editor (needs browsers)"
	@echo "generate      run go generate ./..."
	@echo "fmt           format Go files"
