package bonus

import (
	"context"
	"errors"
	"fmt"
	"math"
	"testing"

	"github.com/vichr-vita/infergo"
)

func baseScenario() Inputs {
	return Inputs{
		EmployeeID:          "E01",
		Active:              true,
		TenureMonths:        48,
		PerformanceScore:    94,
		SalaryCents:         8_000_000,
		Role:                Specialist,
		Department:          Engineering,
		TrainingComplete:    true,
		CompanyTargetMet:    true,
		EmployeeBudgetCents: 1_200_000,
		ManagerApproved:     true,
		FinanceApproved:     true,
		CriticalSkill:       true,
	}
}

// Expected outcomes come from inferrum's 14 fixed bonus scenarios.
func TestBonusScenarios(t *testing.T) {
	tests := []struct {
		name           string
		change         func(*Inputs)
		expectedBonus  uint64
		expectedReview bool
	}{
		{
			name:          "exceptional specialist",
			expectedBonus: 1_049_000,
		},
		{
			name: "budget caps manager bonus",
			change: func(s *Inputs) {
				s.Role = Manager
				s.Department = Sales
				s.EmployeeBudgetCents = 600_000
			},
			expectedBonus: 600_000,
		},
		{
			name:           "finance approval pending",
			change:         func(s *Inputs) { s.FinanceApproved = false },
			expectedReview: true,
		},
		{
			name:   "performance exactly 50",
			change: func(s *Inputs) { s.PerformanceScore = 50 },
		},
		{
			name:          "performance just above 50",
			change:        func(s *Inputs) { s.PerformanceScore = 51 },
			expectedBonus: 741_000,
		},
		{
			name:   "tenure below 12 months",
			change: func(s *Inputs) { s.TenureMonths = 11 },
		},
		{
			name:   "inactive employee",
			change: func(s *Inputs) { s.Active = false },
		},
		{
			name:   "training incomplete",
			change: func(s *Inputs) { s.TrainingComplete = false },
		},
		{
			name:   "disciplinary hold",
			change: func(s *Inputs) { s.DisciplinaryHold = true },
		},
		{
			name:          "company target missed",
			change:        func(s *Inputs) { s.CompanyTargetMet = false },
			expectedBonus: 587_000,
		},
		{
			name: "exactly finance threshold",
			change: func(s *Inputs) {
				s.Role = Clerk
				s.Department = Operations
				s.SalaryCents = 4_000_000
				s.TenureMonths = 12
				s.PerformanceScore = 89
				s.CriticalSkill = false
				s.FinanceApproved = false
			},
			expectedBonus: 200_000,
		},
		{
			name: "one cent above finance threshold",
			change: func(s *Inputs) {
				s.Role = Clerk
				s.Department = Operations
				s.SalaryCents = 4_000_020
				s.TenureMonths = 12
				s.PerformanceScore = 89
				s.CriticalSkill = false
				s.FinanceApproved = false
			},
			expectedReview: true,
		},
		{
			name:           "manager approval pending",
			change:         func(s *Inputs) { s.ManagerApproved = false },
			expectedReview: true,
		},
		{
			name:   "zero allocated budget",
			change: func(s *Inputs) { s.EmployeeBudgetCents = 0 },
		},
	}

	for _, limit := range []int{0, 1, 4} {
		t.Run(fmt.Sprintf("parallel=%d", limit), func(t *testing.T) {
			for i, tt := range tests {
				t.Run(tt.name, func(t *testing.T) {
					t.Parallel()
					input := baseScenario()
					input.EmployeeID = fmt.Sprintf("E%02d", i+1)
					if tt.change != nil {
						tt.change(&input)
					}
					result, err := Evaluate(t.Context(), input, infergo.Options{MaxParallel: limit})
					if err != nil {
						t.Fatal(err)
					}
					if result.FinalBonusCents != tt.expectedBonus {
						t.Errorf("final bonus = %d, want %d", result.FinalBonusCents, tt.expectedBonus)
					}
					if result.TotalCompensationCents != input.SalaryCents+tt.expectedBonus {
						t.Errorf("total compensation = %d, want %d", result.TotalCompensationCents, input.SalaryCents+tt.expectedBonus)
					}
					if (result.ReviewRequired != nil) != tt.expectedReview {
						t.Errorf("review present = %t, want %t", result.ReviewRequired != nil, tt.expectedReview)
					}
					if result.ReviewRequired != nil && *result.ReviewRequired != "approval_pending" {
						t.Errorf("review = %q, want approval_pending", *result.ReviewRequired)
					}
					if tt.expectedBonus == 0 {
						if result.PaymentReadyCents != nil || result.PaymentReference != nil {
							t.Error("zero bonus must not produce a payment or reference")
						}
					} else {
						if result.PaymentReadyCents == nil || *result.PaymentReadyCents != tt.expectedBonus {
							t.Errorf("payment must contain %d cents", tt.expectedBonus)
						}
						expectedReference := fmt.Sprintf("BONUS-%s-%d", input.EmployeeID, tt.expectedBonus)
						if result.PaymentReference == nil || *result.PaymentReference != expectedReference {
							t.Errorf("reference must be %q", expectedReference)
						}
					}
				})
			}
		})
	}
}

func TestPolicyBoundaries(t *testing.T) {
	for _, tt := range []struct {
		score  uint8
		factor uint64
	}{{89, 10_000}, {90, 15_000}} {
		if got := PerformanceFactor(ExceptionalPerformance(tt.score)); got != tt.factor {
			t.Errorf("performance factor at score %d = %d, want %d", tt.score, got, tt.factor)
		}
	}
	for _, tt := range []struct {
		months uint16
		award  uint64
	}{{35, 0}, {36, 50_000}} {
		if got := TenureAward(tt.months); got != tt.award {
			t.Errorf("tenure award at %d months = %d, want %d", tt.months, got, tt.award)
		}
	}
	for role, expected := range map[Role]uint64{Clerk: 500, Specialist: 700, Manager: 800} {
		if got, err := RoleRate(role); err != nil || got != expected {
			t.Errorf("role rate for %s = %d, %v, want %d", role, got, err, expected)
		}
	}
	for department, expected := range map[Department]uint64{Engineering: 11_000, Sales: 12_000, Operations: 10_000} {
		if got, err := DepartmentFactor(department); err != nil || got != expected {
			t.Errorf("department factor for %s = %d, %v, want %d", department, got, err, expected)
		}
	}

	base, err := BaseBonus(101, 500)
	if err != nil || base != 5 {
		t.Fatalf("base bonus = %d, %v, want 5", base, err)
	}
	performance, err := PerformanceBonus(base, 15_000)
	if err != nil || performance != 7 {
		t.Fatalf("performance bonus = %d, %v, want 7", performance, err)
	}
	department, err := DepartmentBonus(performance, 11_000)
	if err != nil || department != 7 {
		t.Fatalf("department bonus = %d, %v, want 7", department, err)
	}
	company, err := CompanyBonus(department, 5_000)
	if err != nil || company != 3 {
		t.Fatalf("company bonus = %d, %v, want 3", company, err)
	}
}

func TestPolicyErrors(t *testing.T) {
	for _, limit := range []int{1, 4} {
		t.Run(fmt.Sprintf("parallel=%d", limit), func(t *testing.T) {
			input := baseScenario()
			input.PerformanceScore = 101
			_, err := Evaluate(t.Context(), input, infergo.Options{MaxParallel: limit})
			assertRuleError(t, err, "GoodPerformance", "performance_score must be between 0 and 100")
			input.PerformanceScore = 94
			input.SalaryCents = math.MaxUint64
			result, err := Evaluate(t.Context(), input, infergo.Options{MaxParallel: limit})
			assertRuleError(t, err, "TotalCompensation", "compensation exceeds u64 cents")
			if result != (Outputs{}) {
				t.Fatal("failed evaluation returned partial outputs")
			}
		})
	}
	if _, err := PerformanceBonus(math.MaxUint64, 15_000); err == nil {
		t.Error("expected bonus overflow")
	}
	if _, err := ProposedBonus(math.MaxUint64, 1, 0); err == nil {
		t.Error("expected proposed bonus overflow")
	}
	if _, err := RoleRate("unknown"); err == nil {
		t.Error("expected unknown role error")
	}
	if _, err := DepartmentFactor("unknown"); err == nil {
		t.Error("expected unknown department error")
	}
}

func assertRuleError(t *testing.T, err error, rule, message string) {
	t.Helper()
	var ruleError *infergo.RuleError
	if !errors.As(err, &ruleError) || ruleError.Rule != rule || ruleError.Err.Error() != message {
		t.Fatalf("error = %v, want rule %s: %s", err, rule, message)
	}
}

func ExampleEvaluate() {
	result, err := Evaluate(context.Background(), Inputs{
		EmployeeID: "E01", Active: true, TenureMonths: 48,
		PerformanceScore: 94, SalaryCents: 8_000_000,
		Role: Specialist, Department: Engineering,
		TrainingComplete: true, CompanyTargetMet: true,
		EmployeeBudgetCents: 1_200_000,
		ManagerApproved:     true, FinanceApproved: true, CriticalSkill: true,
	}, infergo.Options{MaxParallel: 4})
	if err != nil {
		panic(err)
	}
	fmt.Println(result.FinalBonusCents)
	fmt.Println(*result.PaymentReference)
	// Output:
	// 1049000
	// BONUS-E01-1049000
}

func TestScalingWideProduct(t *testing.T) {
	if got, err := CompanyBonus(math.MaxUint64, 10_000); err != nil || got != math.MaxUint64 {
		t.Errorf("100%% of max uint64 = %d, %v, want %d", got, err, uint64(math.MaxUint64))
	}
	if got, err := CompanyBonus(math.MaxUint64, 5_000); err != nil || got != math.MaxUint64/2 {
		t.Errorf("50%% of max uint64 = %d, %v, want %d", got, err, uint64(math.MaxUint64/2))
	}
}
