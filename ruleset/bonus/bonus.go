// Package bonus implements the fictional annual bonus policy from inferrum.
// Amounts are integer cents, and rates are basis points. Parameter and result
// names identify facts shared between rules. Optional facts use nil for absence.
package bonus

import (
	"errors"
	"fmt"
	"math/bits"
)

type Role string

const (
	Clerk      Role = "clerk"
	Specialist Role = "specialist"
	Manager    Role = "manager"
)

type Department string

const (
	Engineering Department = "engineering"
	Sales       Department = "sales"
	Operations  Department = "operations"
)

// GoodPerformance validates the score and requires a score above 50. BR-01.
func GoodPerformance(performanceScore uint8) (goodPerformance bool, performanceScoreError error) {
	if performanceScore > 100 {
		return false, errors.New("performance_score must be between 0 and 100")
	}
	return performanceScore > 50, nil
}

// ExceptionalPerformance requires a score of at least 90. BR-02.
func ExceptionalPerformance(performanceScore uint8) (exceptionalPerformance bool) {
	return performanceScore >= 90
}

// TenureEligible requires at least 12 months of service. BR-03.
func TenureEligible(tenureMonths uint16) (tenureEligible bool) {
	return tenureMonths >= 12
}

// ConductClear requires no active disciplinary hold. BR-04.
func ConductClear(disciplinaryHold bool) (conductClear bool) {
	return !disciplinaryHold
}

// EmploymentEligible requires active employment and eligible tenure. BR-05.
func EmploymentEligible(active bool, tenureEligible bool) (employmentEligible bool) {
	return active && tenureEligible
}

// IsBonusEligible requires eligible employment, good performance, clear conduct,
// and completed training. BR-06.
func IsBonusEligible(employmentEligible bool, goodPerformance bool, conductClear bool, trainingComplete bool) (bonusEligible bool) {
	return employmentEligible && goodPerformance && conductClear && trainingComplete
}

// RoleRate returns 5% for clerks, 7% for specialists, or 8% for managers. BR-07.
func RoleRate(role Role) (roleRateBps uint64, roleError error) {
	switch role {
	case Clerk:
		return 500, nil
	case Specialist:
		return 700, nil
	case Manager:
		return 800, nil
	default:
		return 0, fmt.Errorf("unknown role %q", role)
	}
}

// DepartmentFactor returns 110% for engineering, 120% for sales, or 100% for
// operations. BR-08.
func DepartmentFactor(department Department) (departmentFactorBps uint64, departmentError error) {
	switch department {
	case Engineering:
		return 11_000, nil
	case Sales:
		return 12_000, nil
	case Operations:
		return 10_000, nil
	default:
		return 0, fmt.Errorf("unknown department %q", department)
	}
}

// CompanyFactor returns 100% when the company target is met, otherwise 50%. BR-09.
func CompanyFactor(companyTargetMet bool) (companyFactorBps uint64) {
	if companyTargetMet {
		return 10_000
	}
	return 5_000
}

// PerformanceFactor returns 150% for exceptional performance, otherwise 100%. BR-10.
func PerformanceFactor(exceptionalPerformance bool) (performanceFactorBps uint64) {
	if exceptionalPerformance {
		return 15_000
	}
	return 10_000
}

// BaseBonus multiplies annual salary by the role rate. BR-11.
func BaseBonus(salaryCents uint64, roleRateBps uint64) (baseBonusCents uint64, baseBonusError error) {
	return scaled(salaryCents, roleRateBps)
}

// PerformanceBonus applies the performance factor to the base bonus. BR-12.
func PerformanceBonus(baseBonusCents uint64, performanceFactorBps uint64) (performanceBonusCents uint64, performanceBonusError error) {
	return scaled(baseBonusCents, performanceFactorBps)
}

// DepartmentBonus applies the department factor after performance. BR-13.
func DepartmentBonus(performanceBonusCents uint64, departmentFactorBps uint64) (departmentBonusCents uint64, departmentBonusError error) {
	return scaled(performanceBonusCents, departmentFactorBps)
}

// CompanyBonus applies the company factor after the department factor. BR-14.
func CompanyBonus(departmentBonusCents uint64, companyFactorBps uint64) (companyBonusCents uint64, companyBonusError error) {
	return scaled(departmentBonusCents, companyFactorBps)
}

// TenureAward adds 50,000 cents for at least 36 months of service. BR-15.
func TenureAward(tenureMonths uint16) (tenureAwardCents uint64) {
	if tenureMonths >= 36 {
		return 50_000
	}
	return 0
}

// RetentionAward adds 75,000 cents for critical skills with good performance. BR-16.
func RetentionAward(criticalSkill bool, goodPerformance bool) (retentionAwardCents uint64) {
	if criticalSkill && goodPerformance {
		return 75_000
	}
	return 0
}

// ProposedBonus sums the company-adjusted bonus and both awards. BR-17.
func ProposedBonus(companyBonusCents uint64, tenureAwardCents uint64, retentionAwardCents uint64) (proposedBonusCents uint64, proposedBonusError error) {
	return sum(companyBonusCents, tenureAwardCents, retentionAwardCents)
}

// EligibleBonus allows a payment only for eligible employees. BR-18.
func EligibleBonus(bonusEligible bool, proposedBonusCents uint64) (eligibleBonusCents uint64) {
	if bonusEligible {
		return proposedBonusCents
	}
	return 0
}

// CappedBonus caps the eligible bonus at the employee's allocated budget. BR-19.
func CappedBonus(eligibleBonusCents uint64, employeeBudgetCents uint64) (cappedBonusCents uint64) {
	return min(eligibleBonusCents, employeeBudgetCents)
}

// FinanceRequired requires finance approval strictly above 200,000 cents. BR-20.
func FinanceRequired(cappedBonusCents uint64) (financeRequired bool) {
	return cappedBonusCents > 200_000
}

// ApprovalsSatisfied requires manager approval and any required finance approval. BR-21.
func ApprovalsSatisfied(managerApproved bool, financeRequired bool, financeApproved bool) (approvalsSatisfied bool) {
	return managerApproved && (!financeRequired || financeApproved)
}

// FinalBonus releases the capped bonus only when approvals pass. BR-22.
func FinalBonus(approvalsSatisfied bool, cappedBonusCents uint64) (finalBonusCents uint64) {
	if approvalsSatisfied {
		return cappedBonusCents
	}
	return 0
}

// PaymentReady emits a fact only for a positive final bonus. BR-23.
func PaymentReady(finalBonusCents uint64) (paymentReadyCents *uint64) {
	if finalBonusCents > 0 {
		return &finalBonusCents
	}
	return nil
}

// ReviewRequired emits approval_pending for a positive bonus awaiting approval. BR-24.
func ReviewRequired(cappedBonusCents uint64, approvalsSatisfied bool) (reviewRequired *string) {
	if cappedBonusCents > 0 && !approvalsSatisfied {
		reason := "approval_pending"
		return &reason
	}
	return nil
}

// TotalCompensation adds annual salary and the final bonus. BR-25.
func TotalCompensation(salaryCents uint64, finalBonusCents uint64) (totalCompensationCents uint64, totalCompensationError error) {
	return sum(salaryCents, finalBonusCents)
}

// PaymentReference emits a reference only when a payment-ready fact exists. BR-26.
func PaymentReference(employeeID string, paymentReadyCents *uint64) (paymentReference *string) {
	if paymentReadyCents == nil {
		return nil
	}
	reference := fmt.Sprintf("BONUS-%s-%d", employeeID, *paymentReadyCents)
	return &reference
}

// scaled uses a 128-bit product so only an overflowing result fails. Each
// multiplication rounds down to a cent, as in the original policy.
func scaled(amount uint64, bps uint64) (uint64, error) {
	high, low := bits.Mul64(amount, bps)
	if high >= 10_000 {
		return 0, errors.New("bonus amount exceeds u64 cents")
	}
	result, _ := bits.Div64(high, low, 10_000)
	return result, nil
}

func sum(amounts ...uint64) (uint64, error) {
	var total uint64
	for _, amount := range amounts {
		next, carry := bits.Add64(total, amount, 0)
		if carry != 0 {
			return 0, errors.New("compensation exceeds u64 cents")
		}
		total = next
	}
	return total, nil
}
