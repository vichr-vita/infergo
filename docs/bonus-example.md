# Bonus example

The `ruleset/bonus` package demonstrates a complete graph with 26 rules. It uses
a fictional annual bonus policy to exercise validation, dependent arithmetic,
approval decisions, and optional outputs. The policy is example code, not a
configuration of the engine itself.

Read the [rules](../ruleset/bonus/bonus.go),
[contracts](../ruleset/bonus/facts.go), and
[tests](../ruleset/bonus/bonus_test.go) together. Monetary values use integer
cents. Rates and factors use basis points, where `10_000` means 100%.

## Run it

From the repository root:

```sh
go generate ./ruleset/bonus
go test ./ruleset/bonus -run '^ExampleEvaluate$' -v
go test -race ./ruleset/bonus
```

The [README](../README.md#run-the-example) shows the input literal for the
baseline scenario. The executable example verifies a final bonus of `1049000`
and payment reference `BONUS-E01-1049000`.

## External inputs

The table uses exported Go field names. Their `fact` tags map to the same names
with an initial lowercase letter, as declared in `facts.go`.

| Field | Type | Meaning |
| --- | --- | --- |
| `EmployeeID` | `string` | Used when formatting the payment reference. |
| `Active` | `bool` | Whether employment is active. |
| `TenureMonths` | `uint16` | Completed months of service. |
| `PerformanceScore` | `uint8` | Score validated to be between 0 and 100. |
| `SalaryCents` | `uint64` | Annual salary in cents. |
| `Role` | `Role` | `Clerk`, `Specialist`, or `Manager`. |
| `Department` | `Department` | `Engineering`, `Sales`, or `Operations`. |
| `TrainingComplete` | `bool` | Whether required training is complete. |
| `DisciplinaryHold` | `bool` | Whether an active hold blocks eligibility. |
| `CompanyTargetMet` | `bool` | Selects the company factor. |
| `EmployeeBudgetCents` | `uint64` | Maximum bonus before approval gating. |
| `ManagerApproved` | `bool` | Required manager approval. |
| `FinanceApproved` | `bool` | Finance approval when the threshold requires it. |
| `CriticalSkill` | `bool` | Qualifies for a retention award with good performance. |

`Role` and `Department` are defined string types. Their constant values are
`clerk`, `specialist`, `manager`, `engineering`, `sales`, and `operations`.
Unknown values return errors from their respective rules.

## Rule catalog

The IDs match the comments in `bonus.go`. Fact names are the named results of
these functions; trailing errors do not join the graph.

| ID | Rule | Calculation or decision |
| --- | --- | --- |
| BR-01 | `GoodPerformance` | Reject scores above 100; require a score strictly above 50. |
| BR-02 | `ExceptionalPerformance` | Require a score of at least 90. |
| BR-03 | `TenureEligible` | Require at least 12 months. |
| BR-04 | `ConductClear` | Require no disciplinary hold. |
| BR-05 | `EmploymentEligible` | Require active employment and eligible tenure. |
| BR-06 | `IsBonusEligible` | Require eligible employment, good performance, clear conduct, and completed training. |
| BR-07 | `RoleRate` | Return 500, 700, or 800 basis points for clerk, specialist, or manager. |
| BR-08 | `DepartmentFactor` | Return 11,000 for engineering, 12,000 for sales, or 10,000 for operations. |
| BR-09 | `CompanyFactor` | Return 10,000 if the target is met, otherwise 5,000. |
| BR-10 | `PerformanceFactor` | Return 15,000 for exceptional performance, otherwise 10,000. |
| BR-11 | `BaseBonus` | Scale salary by the role rate. |
| BR-12 | `PerformanceBonus` | Scale the base bonus by the performance factor. |
| BR-13 | `DepartmentBonus` | Apply the department factor. |
| BR-14 | `CompanyBonus` | Apply the company factor. |
| BR-15 | `TenureAward` | Add 50,000 cents for at least 36 months. |
| BR-16 | `RetentionAward` | Add 75,000 cents for a critical skill with good performance. |
| BR-17 | `ProposedBonus` | Add the company-adjusted amount and both awards. |
| BR-18 | `EligibleBonus` | Return the proposal if eligible, otherwise zero. |
| BR-19 | `CappedBonus` | Take the smaller of the eligible amount and employee budget. |
| BR-20 | `FinanceRequired` | Require finance approval strictly above 200,000 cents. |
| BR-21 | `ApprovalsSatisfied` | Require manager approval and any required finance approval. |
| BR-22 | `FinalBonus` | Release the capped amount if approvals pass, otherwise zero. |
| BR-23 | `PaymentReady` | Return a pointer for a positive final bonus, otherwise nil. |
| BR-24 | `ReviewRequired` | Return `approval_pending` for a positive capped bonus awaiting approval. |
| BR-25 | `TotalCompensation` | Add salary and final bonus. |
| BR-26 | `PaymentReference` | Format `BONUS-<employeeID>-<cents>` when a payment is ready, otherwise nil. |

All 26 rules are required by the current output contract. Eligibility and
approval rules gate amounts; they do not dynamically skip their upstream
calculations. An ineligible employee can still encounter invalid role,
department, or arithmetic errors.

## Baseline calculation

The example supplies an active specialist in engineering with 48 months of
service, a score of 94, salary of 8,000,000 cents, a critical skill, and completed
training. There is no disciplinary hold. The company target and both approvals
are satisfied, and the budget is 1,200,000 cents.

| Step | Amount in cents |
| --- | ---: |
| Salary multiplied by the 7% specialist rate | 560,000 |
| Apply the 150% exceptional-performance factor | 840,000 |
| Apply the 110% engineering factor | 924,000 |
| Apply the 100% company factor | 924,000 |
| Add the 50,000 tenure award and 75,000 retention award | 1,049,000 |
| Apply eligibility, budget cap, and approvals | 1,049,000 |
| Add salary for total compensation | 9,049,000 |

## Output meanings

| Field | Type | Meaning |
| --- | --- | --- |
| `FinalBonusCents` | `uint64` | Approved bonus after eligibility and budget checks. |
| `TotalCompensationCents` | `uint64` | Salary plus final bonus. |
| `PaymentReadyCents` | `*uint64` | Positive payable amount, or nil for no payment. |
| `ReviewRequired` | `*string` | `approval_pending` when a positive capped bonus lacks approval, otherwise nil. |
| `PaymentReference` | `*string` | Payment reference, or nil when no payment is ready. |

A nil optional output is a successful result. `PaymentReference` still executes
when `PaymentReady` returns nil and handles that absence explicitly. Check the
pointer before dereferencing it in application code.

## Rounding and overflow

Each scaling step computes `floor(amount * basisPoints / 10_000)`, rounding down
to a whole cent at that step. Combining all factors into one multiplication can
produce a different result because it changes where rounding happens.

The `scaled` helper uses a 128-bit intermediate product through `math/bits`, so
an intermediate product above `uint64` does not fail when the divided result
still fits. A result that cannot fit returns `bonus amount exceeds u64 cents`.
The `sum` helper detects carry and returns `compensation exceeds u64 cents` on
addition overflow, including when called by `ProposedBonus`.

The tests cover 14 scenarios at concurrency limits of 0, 1, and 4, plus policy
boundaries, rounding, wide multiplication, invalid inputs, and overflow. A score
of 50 fails eligibility; 51 passes. Finance approval is unnecessary at exactly
200,000 cents and required at 200,001. See the [runtime
reference](runtime.md#errors-and-cancellation) for how rule errors reach callers.
