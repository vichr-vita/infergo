package infergo

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newTestPlan(t *testing.T, rules []Rule) *Plan {
	t.Helper()
	plan, err := NewPlan(rules)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func receive[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for rule execution")
		var zero T
		return zero
	}
}

func TestPlanDependencyOrdering(t *testing.T) {
	plan := newTestPlan(t, []Rule{
		{Name: "Join", DependsOn: []int{1, 2, 1}},
		{Name: "Left"},
		{Name: "Right"},
		{Name: "Final", DependsOn: []int{0}},
	})
	for _, limit := range []int{0, 1, 4} {
		t.Run(fmt.Sprintf("parallel=%d", limit), func(t *testing.T) {
			values := make([]int, 4)
			err := plan.Run(t.Context(), Options{MaxParallel: limit}, func(_ context.Context, id int) error {
				switch id {
				case 0:
					values[0] = values[1] + values[2]
				case 1:
					values[1] = 2
				case 2:
					values[2] = 3
				case 3:
					values[3] = values[0] * 2
				}
				return nil
			})
			if err != nil || values[3] != 10 {
				t.Fatalf("final = %d, error = %v; want 10, nil", values[3], err)
			}
		})
	}
}

func TestPlanBoundedConcurrencyAndReadiness(t *testing.T) {
	plan := newTestPlan(t, []Rule{
		{Name: "Slow"}, {Name: "Fast"},
		{Name: "FastChild", DependsOn: []int{1}},
		{Name: "Independent"},
		{Name: "Join", DependsOn: []int{0, 2, 3}},
	})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	slowStarted, childStarted, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	var active atomic.Int32
	var peak atomic.Int32
	go func() {
		done <- plan.Run(ctx, Options{MaxParallel: 2}, func(ctx context.Context, id int) error {
			current := active.Add(1)
			defer active.Add(-1)
			for previous := peak.Load(); current > previous; previous = peak.Load() {
				if peak.CompareAndSwap(previous, current) {
					break
				}
			}
			if current > 2 {
				return fmt.Errorf("concurrency exceeded two rules")
			}
			switch id {
			case 0:
				close(slowStarted)
			case 1:
				select {
				case <-slowStarted:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			case 2:
				close(childStarted)
			default:
				return nil
			}
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	// The child must start while the unrelated slow root is still blocked.
	receive(t, childStarted)
	close(release)
	if err := receive(t, done); err != nil {
		t.Fatal(err)
	}
	if peak.Load() != 2 || active.Load() != 0 {
		t.Fatalf("peak = %d, remaining = %d", peak.Load(), active.Load())
	}
}

func TestPlanFailureCancelsAndWaits(t *testing.T) {
	plan := newTestPlan(t, []Rule{
		{Name: "Fail"}, {Name: "Running"},
		{Name: "Dependent", DependsOn: []int{0}},
	})
	sentinel := errors.New("failed")
	started, canceled, allowExit := make(chan struct{}), make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	defer close(allowExit)
	var dependentRan atomic.Bool
	go func() {
		done <- plan.Run(t.Context(), Options{MaxParallel: 2}, func(ctx context.Context, id int) error {
			switch id {
			case 0:
				<-started
				return sentinel
			case 1:
				close(started)
				<-ctx.Done()
				close(canceled)
				<-allowExit
				return ctx.Err()
			default:
				dependentRan.Store(true)
				return nil
			}
		})
	}()
	receive(t, canceled)
	select {
	case <-done:
		t.Fatal("Run returned before running work exited")
	default:
	}
	allowExit <- struct{}{}
	err := receive(t, done)
	var ruleError *RuleError
	if !errors.Is(err, sentinel) || !errors.As(err, &ruleError) || ruleError.Rule != "Fail" {
		t.Fatalf("error = %v, want Fail wrapping sentinel", err)
	}
	if dependentRan.Load() {
		t.Fatal("dependent ran after its producer failed")
	}
}

func TestPlanCancellation(t *testing.T) {
	plan := newTestPlan(t, []Rule{{Name: "Root"}, {Name: "Child", DependsOn: []int{0}}})
	for _, limit := range []int{1, 4} {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		err := plan.Run(ctx, Options{MaxParallel: limit}, func(context.Context, int) error {
			t.Fatal("rule ran with a canceled context")
			return nil
		})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v, want context.Canceled", err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- plan.Run(ctx, Options{MaxParallel: 2}, func(ctx context.Context, id int) error {
			if id != 0 {
				return errors.New("dependent ran during cancellation")
			}
			close(started)
			<-ctx.Done()
			return ctx.Err()
		})
	}()
	receive(t, started)
	cancel()
	if err := receive(t, done); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestPlanConcurrentEvaluations(t *testing.T) {
	rules := []Rule{{Name: "Root"}, {Name: "Child", DependsOn: []int{0}}}
	plan := newTestPlan(t, rules)
	// Callers retain ownership of descriptors and can change them after NewPlan.
	rules[0].Name = "changed"
	rules[1].DependsOn[0] = 1
	var calls sync.WaitGroup
	for input := range 32 {
		calls.Go(func() {
			var value int
			err := plan.Run(t.Context(), Options{MaxParallel: 2}, func(_ context.Context, id int) error {
				if id == 0 {
					value = input
				} else {
					value++
				}
				return nil
			})
			if err != nil || value != input+1 {
				t.Errorf("input %d: result = %d, error = %v", input, value, err)
			}
		})
	}
	calls.Wait()
}

func TestInvalidPlansAndOptions(t *testing.T) {
	for _, rules := range [][]Rule{
		{{Name: "A", DependsOn: []int{1}}, {Name: "B", DependsOn: []int{0}}},
		{{Name: "A", DependsOn: []int{1}}},
		{{Name: "A", DependsOn: []int{-1}}},
		{{Name: "A"}, {Name: "A"}},
		{{}},
	} {
		if _, err := NewPlan(rules); err == nil {
			t.Fatalf("accepted invalid plan: %+v", rules)
		}
	}
	plan := newTestPlan(t, nil)
	if err := plan.Run(t.Context(), Options{}, nil); err != nil {
		t.Fatalf("empty plan: %v", err)
	}
	if err := plan.Run(t.Context(), Options{MaxParallel: -1}, nil); err == nil {
		t.Fatal("accepted negative concurrency")
	}
}
