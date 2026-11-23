// Diagnostics: a deliberately broken file is written from outside, as an IDE
// would, and each problem must show on the element it is about. The evaluator
// on disk follows the compiler's verdict.
const { test, expect, selectRule, fit } = require('./editor-fixture.cjs');

test.describe.configure({ timeout: 60_000 });

const summary = page => page.locator('#summary');
const node = (page, rule) => page.locator(`#graph-root [data-rule="${rule}"]`);
// A node's notes wrap onto several SVG text lines, so match the node as a whole.
const notes = (page, rule) => node(page, rule).locator('[data-key^="note:"]');

/** The ruleset with every use of a name inside one function replaced, so it type-checks but no longer matches the graph. */
const renameWithin = (source, rule, from, to) => source.replace(new RegExp(`func ${rule}\\([\\s\\S]*?\\n}\\n`), body => body.replaceAll(from, to));

test('item 6: a missing producer shows on the read, and one click on the fix link repairs it', async ({ app: page, editor }) => {
  const good = editor.read();
  editor.writeOutside('bonus.go', renameWithin(good, 'FinalBonus', 'cappedBonusCents', 'cappedBonusCent'));

  await expect(summary(page)).toContainText('1 error');
  await expect(node(page, 'FinalBonus')).toHaveClass(/error/);
  await expect(node(page, 'FinalBonus').locator('.graph-fact.bad[data-fact="cappedBonusCent"]')).toHaveCount(1);
  await expect(notes(page, 'FinalBonus')).toHaveCount(1);
  await expect(node(page, 'FinalBonus')).toContainText('No input or rule produces cappedBonusCent.');
  await expect(node(page, 'FinalBonus')).toHaveAttribute('aria-label', /cappedBonusCent uint64, an input|cappedBonusCent uint64/);
  await expect(page.locator('#graph-root .graph-fix')).toHaveText([
    'Rename to cappedBonusCents', 'Add input cappedBonusCent', 'Create a rule that produces cappedBonusCent',
  ]);
  await selectRule(page, 'FinalBonus');
  await expect(page.locator('#sheet-root .sheet-row-problems:not([hidden])')).toContainText('did you mean "cappedBonusCents"?');
  await expect(page.locator('#sheet-root .sheet-origin', { hasText: 'No producer' })).toBeVisible();

  await page.locator('#graph-root .graph-fix', { hasText: 'Rename to cappedBonusCents' }).click();
  await expect(page.locator('#status')).toContainText('Renamed fact cappedBonusCent to cappedBonusCents in 1 rule');
  await expect(summary(page)).toContainText('0 errors');
  await expect(node(page, 'FinalBonus')).not.toHaveClass(/error/);
  expect(editor.read()).toBe(good);
  editor.run('go', ['build', './...']);
});

test('item 6: a type mismatch shows on the wire and the reader, and one click on the fix link repairs it', async ({ app: page, editor }) => {
  const good = editor.read();
  editor.editOutside('bonus.go', 'func FinanceRequired(cappedBonusCents uint64)', 'func FinanceRequired(cappedBonusCents uint32)');

  await expect(summary(page)).toContainText('1 error');
  await expect(node(page, 'FinanceRequired')).toHaveClass(/error/);
  await expect(node(page, 'FinanceRequired').locator('.graph-fact.bad[data-fact="cappedBonusCents"]')).toHaveCount(1);
  await expect(node(page, 'FinanceRequired')).toContainText(/cappedBonusCents is uint64 from\s*CappedBonus and uint32 here\./);
  await expect(node(page, 'FinanceRequired').locator('.ptype', { hasText: 'uint32 ≠ uint64' })).toHaveCount(1);
  const wire = page.locator('#graph-root .graph-wire[data-wire="CappedBonus>cappedBonusCents>FinanceRequired"]');
  await expect(wire).toHaveClass(/error/);
  await expect(page.locator('#graph-root .graph-label[data-wire="CappedBonus>cappedBonusCents>FinanceRequired"]')).toHaveClass(/error/);
  await selectRule(page, 'FinanceRequired');
  await expect(page.locator('#sheet-root .sheet-row-problems:not([hidden])')).toContainText('has type uint64, expected uint32');

  await page.locator('#graph-root .graph-fix', { hasText: 'Use uint64 in FinanceRequired' }).click();
  await expect(page.locator('#status')).toContainText('FinanceRequired');
  await expect(summary(page)).toContainText('0 errors');
  expect(editor.read()).toBe(good);
  editor.run('go', ['build', './...']);
});

test('item 6: a cycle shows on every rule on it, and a fix link removes one wire', async ({ app: page, editor }) => {
  const good = editor.read();
  editor.editOutside('bonus.go', 'func CappedBonus(eligibleBonusCents uint64, employeeBudgetCents uint64)', 'func CappedBonus(eligibleBonusCents uint64, employeeBudgetCents uint64, approvalsSatisfied bool)');

  await expect(summary(page)).toContainText('1 error');
  for (const rule of ['CappedBonus', 'FinanceRequired', 'ApprovalsSatisfied']) {
    await expect(node(page, rule)).toHaveClass(/error/);
    await expect(node(page, rule)).toHaveAttribute('aria-label', /1 problem/);
  }
  // The note that names the whole cycle sits on the rule the compiler reported.
  await expect(node(page, 'CappedBonus')).toContainText(/On a cycle: CappedBonus\s*→\s*ApprovalsSatisfied\s*→\s*FinanceRequired\s*→\s*CappedBonus/);
  await expect(node(page, 'FinalBonus')).not.toHaveClass(/error/);
  await expect(page.locator('#graph-root .graph-fix')).toHaveText([
    'Remove approvalsSatisfied from CappedBonus', 'Remove financeRequired from ApprovalsSatisfied', 'Remove cappedBonusCents from FinanceRequired',
  ]);

  await fit(page);
  await page.locator('#graph-root .graph-fix', { hasText: 'Remove approvalsSatisfied from CappedBonus' }).click();
  await expect(summary(page)).toContainText('0 errors');
  expect(editor.read()).toBe(good);
});

// The compiler lists a cycle's rules in reads order (CappedBonus,
// ApprovalsSatisfied, FinanceRequired), the reverse of the wires' direction.
test('item 6: every wire on a cycle turns red', async ({ app: page, editor }) => {
  editor.editOutside('bonus.go', 'func CappedBonus(eligibleBonusCents uint64, employeeBudgetCents uint64)', 'func CappedBonus(eligibleBonusCents uint64, employeeBudgetCents uint64, approvalsSatisfied bool)');
  await expect(summary(page)).toContainText('1 error');
  for (const wire of ['CappedBonus>cappedBonusCents>FinanceRequired', 'FinanceRequired>financeRequired>ApprovalsSatisfied', 'ApprovalsSatisfied>approvalsSatisfied>CappedBonus']) {
    await expect(page.locator(`#graph-root .graph-wire[data-wire="${wire}"]`)).toHaveClass(/error/);
  }
});

test('item 6: a Go type error shows on the rule and on the line in the code pane', async ({ app: page, editor }) => {
  editor.editOutside('bonus.go', 'return performanceScore >= 90', 'return "oops"');

  await expect(summary(page)).toContainText('1 error');
  await expect(node(page, 'ExceptionalPerformance')).toHaveClass(/error/);
  await expect(node(page, 'ExceptionalPerformance')).toContainText(/Line \d+: cannot use "oops"/);
  for (const other of ['GoodPerformance', 'PerformanceFactor']) await expect(node(page, other)).not.toHaveClass(/error/);
  await selectRule(page, 'ExceptionalPerformance');
  await expect(page.locator('#sheet-root .sheet-problems')).toContainText('"oops"');
  await expect(page.locator('#code-root .code-edit .cm-mark-error')).toHaveCount(1);
  await expect(page.locator('#code-root .code-edit .cm-line', { hasText: 'return "oops"' })).toBeVisible();
  // A Go error has no fix to offer.
  await expect(page.locator('#sheet-root .fixes button')).toHaveCount(0);
});

test('item 13: the evaluator on disk is regenerated when the ruleset is valid', async ({ app: page, editor }) => {
  const evaluatorBefore = editor.read('zz_infergo_gen.go');
  expect(evaluatorBefore).toContain('finalBonusCents');
  await page.locator('#facts-root .fact-row[aria-label^="finalBonusCents "]').first().focus();
  await page.keyboard.press('F2');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('finalPayoutCents');
  await page.keyboard.press('Enter');

  await expect(page.locator('#status')).toContainText('Renamed fact finalBonusCents to finalPayoutCents');
  await expect(summary(page)).toContainText('Evaluator updated');
  const evaluatorAfter = editor.read('zz_infergo_gen.go');
  expect(evaluatorAfter).not.toBe(evaluatorBefore);
  expect(evaluatorAfter).toContain('finalPayoutCents');
  expect(evaluatorAfter).not.toContain('finalBonusCents');
  editor.run('go', ['vet', './...']);
  editor.run('go', ['build', './...']);
});

test('item 13: the evaluator on disk is kept when the ruleset is not valid', async ({ app: page, editor }) => {
  const good = editor.read();
  const evaluatorBefore = editor.read('zz_infergo_gen.go');

  // A Go type error.
  editor.editOutside('bonus.go', 'return performanceScore >= 90', 'return "oops"');
  await expect(summary(page)).toContainText('Evaluator kept from the last valid check');
  expect(editor.read('zz_infergo_gen.go')).toBe(evaluatorBefore);

  // A graph error that Go accepts: a missing producer.
  editor.writeOutside('bonus.go', renameWithin(good, 'FinalBonus', 'cappedBonusCents', 'cappedBonusCent'));
  await expect(summary(page)).toContainText('1 error');
  await expect(summary(page)).toContainText('Evaluator kept from the last valid check');
  await expect(node(page, 'ExceptionalPerformance')).not.toHaveClass(/error/);
  expect(editor.read('zz_infergo_gen.go')).toBe(evaluatorBefore);

  // Fixing the file brings the evaluator back in step. Nothing changed, so it stays byte for byte.
  editor.writeOutside('bonus.go', good);
  await expect(summary(page)).toContainText('0 errors');
  await expect(summary(page)).toContainText('Evaluator current');
  expect(editor.read('zz_infergo_gen.go')).toBe(evaluatorBefore);
});
