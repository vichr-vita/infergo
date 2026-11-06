// Package infergo schedules generated, typed DAG rule evaluations.
package infergo

import (
	"context"
	"fmt"
	"runtime"
	"runtime/debug"
	"slices"
	"sync"
	"sync/atomic"
)

// Options controls a single evaluation.
type Options struct {
	// MaxParallel bounds running rules. Zero and one execute sequentially,
	// without worker goroutines. Negative values are invalid. A rule panic
	// reaches the caller of Plan.Run at every value.
	MaxParallel int
}

// Rule describes a rule's dependencies by their indices in a plan.
type Rule struct {
	Name      string
	DependsOn []int
}

// RuleError identifies the rule that failed and preserves its original error.
type RuleError struct {
	Rule string
	Err  error
}

func (e *RuleError) Error() string { return fmt.Sprintf("rule %s: %v", e.Rule, e.Err) }
func (e *RuleError) Unwrap() error { return e.Err }

// PanicError is the value Plan.Run panics with when a rule panics. It has the
// same form at every MaxParallel, so a caller's recover needs only one case.
type PanicError struct {
	Rule  string
	Value any    // The value the rule panicked with.
	Stack []byte // The stack at the panic site, as formatted by debug.Stack.
}

// Error names the rule and includes the stack, because a crash from an
// unrecovered PanicError prints only this text and the caller's stack.
func (e *PanicError) Error() string {
	return fmt.Sprintf("rule %s panicked: %v\n\n%s", e.Rule, e.Value, e.Stack)
}

// Unwrap returns Value if it is an error, and nil otherwise.
func (e *PanicError) Unwrap() error {
	err, _ := e.Value.(error)
	return err
}

// Plan is an immutable dependency graph. A plan can serve concurrent evaluations;
// each call to Run must use its own fact storage.
type Plan struct {
	names      []string
	dependents [][]int
	pending    []int
	order      []int
}

// NewPlan copies and validates a graph. Repeated dependencies count only once.
func NewPlan(rules []Rule) (*Plan, error) {
	p := &Plan{
		names:      make([]string, len(rules)),
		dependents: make([][]int, len(rules)),
		pending:    make([]int, len(rules)),
	}
	names := make(map[string]bool, len(rules))
	for id, rule := range rules {
		if rule.Name == "" || names[rule.Name] {
			return nil, fmt.Errorf("infergo: rule %d must have a unique, nonempty name", id)
		}
		names[rule.Name] = true
		p.names[id] = rule.Name
		seen := make(map[int]bool, len(rule.DependsOn))
		for _, dependency := range rule.DependsOn {
			if dependency < 0 || dependency >= len(rules) {
				return nil, fmt.Errorf("infergo: rule %s has invalid dependency %d", rule.Name, dependency)
			}
			if !seen[dependency] {
				seen[dependency] = true
				p.pending[id]++
				p.dependents[dependency] = append(p.dependents[dependency], id)
			}
		}
	}
	pending := slices.Clone(p.pending)
	for id, count := range pending {
		if count == 0 {
			p.order = append(p.order, id)
		}
	}
	for head := 0; head < len(p.order); head++ {
		for _, dependent := range p.dependents[p.order[head]] {
			pending[dependent]--
			if pending[dependent] == 0 {
				p.order = append(p.order, dependent)
			}
		}
	}
	if len(p.order) != len(rules) {
		return nil, fmt.Errorf("infergo: rule graph contains a cycle")
	}
	return p, nil
}

// Run invokes each rule once, after all its dependencies succeed. Execute must
// write only that rule's outputs and treat all inputs as immutable. Completion
// synchronizes those writes with dependent rules. On failure or cancellation,
// Run cancels the execution context and waits for running calls before returning.
// Rules that ignore cancellation can delay that return.
//
// A rule that panics stops evaluation the same way. Once started calls have
// returned, Run panics on its caller's goroutine with a *PanicError, whatever
// the MaxParallel. That panic takes precedence over errors and cancellation, and
// Run raises only one if several rules panic. Likewise, a rule that calls
// runtime.Goexit, as t.FailNow does, ends the goroutine that called Run. If a
// deferred function panics during that Goexit, Run still panics. Go resumes the
// Goexit after a recover on the same goroutine, so in sequential execution the
// goroutine exits once the recovering function finishes.
func (p *Plan) Run(ctx context.Context, options Options, execute func(context.Context, int) error) error {
	if options.MaxParallel < 0 {
		return fmt.Errorf("infergo: MaxParallel must not be negative")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	limit := min(options.MaxParallel, len(p.names))
	if limit <= 1 {
		var firstPanic atomic.Pointer[PanicError]
		// Raising from here also works while a Goexit ends this goroutine.
		defer func() {
			cancel()
			if panicked := firstPanic.Load(); panicked != nil {
				panic(panicked)
			}
		}()
		for _, id := range p.order {
			if err := ctx.Err(); err != nil {
				return err
			}
			panicked, err := p.call(ctx, id, execute, &firstPanic)
			if panicked != nil {
				firstPanic.CompareAndSwap(nil, panicked)
				return nil // The deferred function raises it.
			}
			if err != nil {
				return &RuleError{Rule: p.names[id], Err: err}
			}
		}
		return ctx.Err()
	}

	type completion struct {
		id  int
		err error
	}
	jobs := make(chan int)
	// Every running worker can finish even after the coordinator stops reading.
	completed := make(chan completion, limit)
	// Evaluation-local, because a plan can serve concurrent runs. Workers record
	// these and cancel, which stops the coordinator without a completion.
	var firstPanic atomic.Pointer[PanicError]
	var exited atomic.Bool
	var workers sync.WaitGroup
	for range limit {
		workers.Go(func() {
			// The loop ends early only if a rule calls runtime.Goexit.
			drained := false
			defer func() {
				if !drained {
					exited.Store(true)
					cancel()
				}
			}()
			for id := range jobs {
				// The coordinator's select can dispatch as cancellation arrives.
				if ctx.Err() != nil {
					continue
				}
				panicked, err := p.call(ctx, id, execute, &firstPanic)
				if panicked != nil {
					firstPanic.CompareAndSwap(nil, panicked)
					cancel()
					continue
				}
				completed <- completion{id: id, err: err}
			}
			drained = true
		})
	}
	// Raising from here replaces any error Run was returning. Workers have
	// stopped by then, so nothing is left running and no panic can be missed.
	defer func() {
		cancel()
		close(jobs)
		workers.Wait()
		if panicked := firstPanic.Load(); panicked != nil {
			panic(panicked)
		}
		if exited.Load() {
			runtime.Goexit()
		}
	}()

	pending := slices.Clone(p.pending)
	ready := make([]int, 0, len(p.names))
	for id, count := range pending {
		if count == 0 {
			ready = append(ready, id)
		}
	}
	head, running, finished := 0, 0, 0
	for finished < len(p.names) {
		if err := ctx.Err(); err != nil {
			return err
		}
		var dispatch chan<- int
		var next int
		if head < len(ready) && running < limit {
			dispatch, next = jobs, ready[head]
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case dispatch <- next:
			head++
			running++
		case result := <-completed:
			running--
			finished++
			if result.err != nil {
				return &RuleError{Rule: p.names[result.id], Err: result.err}
			}
			for _, dependent := range p.dependents[result.id] {
				pending[dependent]--
				if pending[dependent] == 0 {
					ready = append(ready, dependent)
				}
			}
		}
	}
	return ctx.Err()
}

// call runs one rule and returns any panic instead of unwinding, so the caller
// can choose where to raise it. The caller must store that panic in firstPanic.
//
// A runtime.Goexit in the rule still ends the goroutine and call never returns,
// so call stores a panic raised during that Goexit itself. Only a non-nil value
// can be stored here, because recover returns nil for a plain Goexit. It also
// returns nil for panic(nil) under GODEBUG=panicnil=1, so a rule that did not
// return is the sign of a panic. Unlike a Goexit, that nil panic reaches the caller.
func (p *Plan) call(ctx context.Context, id int, execute func(context.Context, int) error, firstPanic *atomic.Pointer[PanicError]) (panicked *PanicError, err error) {
	returned := false
	defer func() {
		if returned {
			return
		}
		value := recover()
		panicked = &PanicError{Rule: p.names[id], Value: value, Stack: debug.Stack()}
		if value != nil {
			firstPanic.CompareAndSwap(nil, panicked)
		}
	}()
	err = execute(ctx, id)
	returned = true
	return nil, err
}
