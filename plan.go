// Package infergo schedules generated, typed DAG rule evaluations.
package infergo

import (
	"context"
	"fmt"
	"slices"
	"sync"
)

// Options controls a single evaluation.
type Options struct {
	// MaxParallel bounds running rules. Zero and one execute sequentially,
	// without worker goroutines. Negative values are invalid.
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
		defer cancel()
		for _, id := range p.order {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := execute(ctx, id); err != nil {
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
	var workers sync.WaitGroup
	for range limit {
		workers.Go(func() {
			for id := range jobs {
				completed <- completion{id: id, err: execute(ctx, id)}
			}
		})
	}
	defer func() {
		cancel()
		close(jobs)
		workers.Wait()
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
