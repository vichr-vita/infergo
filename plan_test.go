package infergo

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
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

// explode panics in a named frame that tests can find in a captured stack.
func explode(value any) { panic(value) }

// runRecovering returns the value Run panicked with, or nil if it returned.
func runRecovering(ctx context.Context, plan *Plan, options Options, execute func(context.Context, int) error) (recovered any) {
	defer func() { recovered = recover() }()
	if err := plan.Run(ctx, options, execute); err != nil {
		return fmt.Errorf("Run returned instead of panicking: %w", err)
	}
	return errors.New("Run returned nil instead of panicking")
}

func requirePanicError(t *testing.T, recovered any, rule string) *PanicError {
	t.Helper()
	panicError, ok := recovered.(*PanicError)
	if !ok {
		t.Fatalf("recovered %T (%v), want *PanicError", recovered, recovered)
	}
	if panicError.Rule != rule {
		t.Fatalf("panic rule = %q, want %q", panicError.Rule, rule)
	}
	return panicError
}

func TestPlanPanicReachesCaller(t *testing.T) {
	plan := newTestPlan(t, []Rule{
		{Name: "Root"},
		{Name: "Explode", DependsOn: []int{0}},
		{Name: "Dependent", DependsOn: []int{1}},
	})
	cause := errors.New("boom")
	for _, limit := range []int{0, 1, 4} {
		for _, value := range []any{cause, "boom"} {
			t.Run(fmt.Sprintf("parallel=%d/%T", limit, value), func(t *testing.T) {
				var dependentRan atomic.Bool
				recovered := runRecovering(t.Context(), plan, Options{MaxParallel: limit}, func(_ context.Context, id int) error {
					switch id {
					case 1:
						explode(value)
					case 2:
						dependentRan.Store(true)
					}
					return nil
				})
				panicError := requirePanicError(t, recovered, "Explode")
				if panicError.Value != value {
					t.Fatalf("panic value = %v, want %v", panicError.Value, value)
				}
				if got, want := errors.Is(panicError, cause), value == any(cause); got != want {
					t.Fatalf("errors.Is(cause) = %v, want %v", got, want)
				}
				if !strings.Contains(string(panicError.Stack), "infergo.explode") {
					t.Fatalf("stack does not reach the panic site:\n%s", panicError.Stack)
				}
				if message := panicError.Error(); !strings.Contains(message, "rule Explode panicked: boom") {
					t.Fatalf("Error() = %q", message)
				}
				if dependentRan.Load() {
					t.Fatal("dependent ran after its producer panicked")
				}
			})
		}
	}
}

func TestPlanPanicCancelsAndWaits(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		plan := newTestPlan(t, []Rule{
			{Name: "Explode"}, {Name: "Running"},
			{Name: "Queued"},
			{Name: "Dependent", DependsOn: []int{0}},
		})
		started, allowExit := make(chan struct{}), make(chan struct{})
		var canceled, extraRuleRan atomic.Bool
		done := make(chan any, 1)
		go func() {
			done <- runRecovering(t.Context(), plan, Options{MaxParallel: 2}, func(ctx context.Context, id int) error {
				switch id {
				case 0:
					<-started
					explode("boom")
				case 1:
					close(started)
					<-ctx.Done()
					canceled.Store(true)
					<-allowExit
					return ctx.Err()
				default:
					extraRuleRan.Store(true)
				}
				return nil
			})
		}()
		// Everything is now blocked, so a Run that waits cannot have raised yet.
		synctest.Wait()
		select {
		case <-done:
			t.Fatal("Run panicked before running work exited")
		default:
		}
		if !canceled.Load() {
			t.Fatal("running rule was not canceled")
		}
		close(allowExit)
		requirePanicError(t, <-done, "Explode")
		if extraRuleRan.Load() {
			t.Fatal("a rule started after the panic")
		}
	})
}

func TestPlanPanicBeatsError(t *testing.T) {
	plan := newTestPlan(t, []Rule{{Name: "Fail"}, {Name: "Explode"}})
	started := make(chan struct{})
	recovered := runRecovering(t.Context(), plan, Options{MaxParallel: 2}, func(ctx context.Context, id int) error {
		if id == 0 {
			<-started
			return errors.New("failed")
		}
		close(started)
		// Cancellation shows the coordinator has already seen the error.
		<-ctx.Done()
		explode("boom")
		return nil
	})
	requirePanicError(t, recovered, "Explode")
}

func TestPlanRaisesOnePanic(t *testing.T) {
	plan := newTestPlan(t, []Rule{{Name: "First"}, {Name: "Second"}})
	var entered sync.WaitGroup
	entered.Add(2)
	recovered := runRecovering(t.Context(), plan, Options{MaxParallel: 2}, func(_ context.Context, id int) error {
		entered.Done()
		entered.Wait()
		explode(id)
		return nil
	})
	panicError, ok := recovered.(*PanicError)
	if !ok || panicError.Rule != plan.names[panicError.Value.(int)] {
		t.Fatalf("recovered %#v, want the panic of one rule", recovered)
	}
}

func TestPlanGoexitEndsCallerGoroutine(t *testing.T) {
	plan := newTestPlan(t, []Rule{
		{Name: "Exit"}, {Name: "Running"},
		{Name: "Dependent", DependsOn: []int{0}},
	})
	for _, limit := range []int{0, 2} {
		t.Run(fmt.Sprintf("parallel=%d", limit), func(t *testing.T) {
			var runReturned, dependentRan atomic.Bool
			done := make(chan struct{})
			go func() {
				defer close(done)
				_ = plan.Run(t.Context(), Options{MaxParallel: limit}, func(ctx context.Context, id int) error {
					switch id {
					case 0:
						runtime.Goexit()
					case 1:
						<-ctx.Done()
					default:
						dependentRan.Store(true)
					}
					return nil
				})
				runReturned.Store(true)
			}()
			receive(t, done)
			if runReturned.Load() || dependentRan.Load() {
				t.Fatalf("run returned = %v, dependent ran = %v", runReturned.Load(), dependentRan.Load())
			}
		})
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
