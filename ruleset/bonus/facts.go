package bonus

//go:generate go run ../../cmd/infergen --rules bonus.go --inputs Inputs --outputs Outputs

// Inputs contains the external facts for one employee's bonus calculation.
type Inputs struct {
	EmployeeID          string     `fact:"employeeID"`
	Active              bool       `fact:"active"`
	TenureMonths        uint16     `fact:"tenureMonths"`
	PerformanceScore    uint8      `fact:"performanceScore"`
	SalaryCents         uint64     `fact:"salaryCents"`
	Role                Role       `fact:"role"`
	Department          Department `fact:"department"`
	TrainingComplete    bool       `fact:"trainingComplete"`
	DisciplinaryHold    bool       `fact:"disciplinaryHold"`
	CompanyTargetMet    bool       `fact:"companyTargetMet"`
	EmployeeBudgetCents uint64     `fact:"employeeBudgetCents"`
	ManagerApproved     bool       `fact:"managerApproved"`
	FinanceApproved     bool       `fact:"financeApproved"`
	CriticalSkill       bool       `fact:"criticalSkill"`
}

// Outputs contains the requested facts. Nil pointers represent successful
// calculations with no payment or review to emit.
type Outputs struct {
	FinalBonusCents        uint64  `fact:"finalBonusCents"`
	TotalCompensationCents uint64  `fact:"totalCompensationCents"`
	PaymentReadyCents      *uint64 `fact:"paymentReadyCents"`
	ReviewRequired         *string `fact:"reviewRequired"`
	PaymentReference       *string `fact:"paymentReference"`
}
