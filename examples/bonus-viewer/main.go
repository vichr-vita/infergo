// Command bonus-viewer exports the bonus rules and saved evaluation scenarios.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/vichr-vita/infergo"
	"github.com/vichr-vita/infergo/ruleset/bonus"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	path := "bonus.html"
	if len(os.Args) > 1 {
		path = os.Args[1]
	}
	base := bonus.Inputs{
		EmployeeID: "E01", Active: true, TenureMonths: 48, PerformanceScore: 94,
		SalaryCents: 8_000_000, Role: bonus.Specialist, Department: bonus.Engineering,
		TrainingComplete: true, CompanyTargetMet: true, EmployeeBudgetCents: 1_200_000,
		ManagerApproved: true, FinanceApproved: true, CriticalSkill: true,
	}
	scenarios := []struct {
		id, label string
		change    func(*bonus.Inputs)
	}{
		{"specialist", "Exceptional specialist", nil},
		{"capped", "Budget caps manager bonus", func(i *bonus.Inputs) {
			i.Role, i.Department, i.EmployeeBudgetCents = bonus.Manager, bonus.Sales, 600_000
		}},
		{"finance-pending", "Finance approval pending", func(i *bonus.Inputs) { i.FinanceApproved = false }},
		{"score-50", "Performance exactly 50", func(i *bonus.Inputs) { i.PerformanceScore = 50 }},
		{"score-51", "Performance just above 50", func(i *bonus.Inputs) { i.PerformanceScore = 51 }},
		{"tenure", "Tenure below 12 months", func(i *bonus.Inputs) { i.TenureMonths = 11 }},
		{"inactive", "Inactive employee", func(i *bonus.Inputs) { i.Active = false }},
		{"training", "Training incomplete", func(i *bonus.Inputs) { i.TrainingComplete = false }},
		{"conduct", "Disciplinary hold", func(i *bonus.Inputs) { i.DisciplinaryHold = true }},
		{"company", "Company target missed", func(i *bonus.Inputs) { i.CompanyTargetMet = false }},
		{"threshold", "Exactly finance threshold", func(i *bonus.Inputs) {
			i.Role, i.Department, i.SalaryCents = bonus.Clerk, bonus.Operations, 4_000_000
			i.TenureMonths, i.PerformanceScore, i.CriticalSkill, i.FinanceApproved = 12, 89, false, false
		}},
		{"above-threshold", "One cent above finance threshold", func(i *bonus.Inputs) {
			i.Role, i.Department, i.SalaryCents = bonus.Clerk, bonus.Operations, 4_000_020
			i.TenureMonths, i.PerformanceScore, i.CriticalSkill, i.FinanceApproved = 12, 89, false, false
		}},
		{"manager-pending", "Manager approval pending", func(i *bonus.Inputs) { i.ManagerApproved = false }},
		{"zero-budget", "Zero allocated budget", func(i *bonus.Inputs) { i.EmployeeBudgetCents = 0 }},
		{"invalid-role", "Unsupported role", func(i *bonus.Inputs) { i.Role = "contractor" }},
	}
	cases := make([]bonus.ViewerCase, 0, len(scenarios))
	for _, scenario := range scenarios {
		input := base
		if scenario.change != nil {
			scenario.change(&input)
		}
		cases = append(cases, bonus.ViewerCase{
			ID: scenario.id, Label: scenario.label, Inputs: input, Options: infergo.Options{MaxParallel: 4},
		})
	}
	html, err := bonus.ExportHTML(context.Background(), "Bonus rules", cases)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(html), 0o644); err != nil {
		return err
	}
	fmt.Println(path)
	return nil
}
