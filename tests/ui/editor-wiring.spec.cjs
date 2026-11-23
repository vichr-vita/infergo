// Wiring by pointer: drop a fact on a rule, remove a wire, refuse a cycle.
// Every test checks the Go files on disk as well as the page.
const { test, expect, changedLines, commentLines, fit, factRow, pickUp, moveOver, nodeBox, clickRuleName, selectRule, showRule, dragFactOntoRule, receipt } = require('./editor-fixture.cjs');

test.describe.configure({ timeout: 60_000 });

const reviewBefore = 'func ReviewRequired(cappedBonusCents uint64, approvalsSatisfied bool) (reviewRequired *string) {';
const reviewAfter = 'func ReviewRequired(cappedBonusCents uint64, approvalsSatisfied bool, financeRequired bool) (reviewRequired *string) {';

test('item 2: dragging a fact onto a rule previews the diff while aiming and writes one changed line on drop', async ({ app: page, editor }) => {
  const before = editor.read();
  await fit(page);

  await pickUp(page, factRow(page, 'financeRequired'));
  await moveOver(page, nodeBox(page, 'ReviewRequired'));

  // Aiming: the rule is a target, the code pane previews the new parameter, and nothing is written.
  await expect(page.locator('#status')).toContainText('Drop to add financeRequired bool to ReviewRequired');
  await expect(page.locator('#graph-root [data-rule="ReviewRequired"]')).toHaveClass(/target/);
  await expect(page.locator('#code-root .code-preview')).toBeVisible();
  await expect(page.locator('#code-root .code-preview .cm-ins')).toHaveText(', financeRequired bool');
  await expect(page.locator('#code-root .code-preview .cm-content')).toContainText('func ReviewRequired(');
  await expect(page.locator('#sheet-root .sheet-name')).toHaveText('ReviewRequired()');
  expect(editor.read()).toBe(before);

  await page.mouse.up();
  await receipt(page, 'Added read financeRequired bool to ReviewRequired');
  await receipt(page, 'bonus.go +1 −1');

  const after = editor.read();
  expect(changedLines(before, after)).toEqual([{ line: 188, before: reviewBefore, after: reviewAfter }]);
  expect(editor.gofmtList('bonus.go')).toBe('');
  for (const line of commentLines(before)) expect(after).toContain(line);
  expect(commentLines(after)).toEqual(commentLines(before));
  expect(editor.read('facts.go')).toContain('fact:"finalBonusCents"');

  await expect(page.locator('#graph-root .graph-wire[data-wire="FinanceRequired>financeRequired>ReviewRequired"]')).toHaveCount(1);
  await expect(page.locator('#summary')).toContainText('0 errors');
});

test('item 2: click then click wires the same way as a drag', async ({ app: page, editor }) => {
  const before = editor.read();
  await fit(page);
  await factRow(page, 'financeRequired').click();
  await expect(page.locator('#status')).toContainText('Holding financeRequired bool');
  await clickRuleName(page, 'ReviewRequired');
  await receipt(page, 'Added read financeRequired bool to ReviewRequired');
  expect(editor.read().replace(reviewAfter, reviewBefore)).toBe(before);
});

test('item 2: Esc and releasing on nothing cancel a drag without writing', async ({ app: page, editor }) => {
  const before = editor.read();
  await fit(page);
  await pickUp(page, factRow(page, 'financeRequired'));
  await moveOver(page, nodeBox(page, 'ReviewRequired'));
  await expect(page.locator('#status')).toContainText('Drop to add');
  await page.keyboard.press('Escape');
  await expect(page.locator('#status')).not.toContainText('Drop to add');
  await page.mouse.up();
  expect(editor.read()).toBe(before);
  await expect(page.locator('#undo')).toBeDisabled();
});

test('item 3: selecting a wire and pressing Delete removes the parameter, and the leftover use shows as an error', async ({ app: page, editor }) => {
  const before = editor.read();
  await showRule(page, 'ReviewRequired');
  await page.locator('#graph-root .graph-label[data-wire="ApprovalsSatisfied>approvalsSatisfied>ReviewRequired"]').click({ force: true });
  await expect(page.locator('#graph-root .graph-wire[data-wire="ApprovalsSatisfied>approvalsSatisfied>ReviewRequired"]')).toHaveClass(/chosen/);
  await page.keyboard.press('Delete');

  await receipt(page, 'Removed read approvalsSatisfied from ReviewRequired');
  await receipt(page, '1 use remains in its body');
  const after = editor.read();
  expect(changedLines(before, after)).toEqual([{
    line: 188,
    before: reviewBefore,
    after: 'func ReviewRequired(cappedBonusCents uint64) (reviewRequired *string) {',
  }]);
  expect(editor.gofmtList('bonus.go')).toBe('');

  // The compiler's verdict lands on the rule in the graph, in the sheet, and on the line in the code pane.
  const node = page.locator('#graph-root [data-rule="ReviewRequired"]');
  await expect(node).toHaveClass(/error/);
  await expect(node.locator('.note')).toContainText('undefined: approvalsSatisfied');
  await expect(node).toHaveAttribute('aria-label', /1 problem/);
  await expect(page.locator('#summary')).toContainText('1 error');
  await expect(page.locator('#sheet-root .sheet-problems')).toContainText('undefined: approvalsSatisfied');
  const marked = page.locator('#code-root .code-edit .cm-mark-error');
  await expect(marked).toHaveCount(1);
  await expect(page.locator('#code-root .code-edit .cm-line', { hasText: '!approvalsSatisfied' })).toBeVisible();
  await expect(page.locator('#graph-root .graph-wire[data-wire="ApprovalsSatisfied>approvalsSatisfied>ReviewRequired"]')).toHaveCount(0);
});

// Product bug, not a test fault: at Fit map, hovering the selected rule's label marks its fact lit, which reveals the same fact's
// overlapping label on another wire, hides the hovered one as crowded, and the press then lands on that other wire.
test.fixme("item 3: at Fit map, pressing the selected rule's wire label selects that wire and not an overlapping label of the same fact", async ({ app: page }) => {
  await selectRule(page, 'ReviewRequired');
  const label = page.locator('#graph-root .graph-label[data-wire="ApprovalsSatisfied>approvalsSatisfied>ReviewRequired"]');
  const box = await label.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('#graph-root .graph-wire.chosen')).toHaveAttribute('data-wire', 'ApprovalsSatisfied>approvalsSatisfied>ReviewRequired');
});

test("item 3: the sheet's remove button removes the parameter, and the leftover use shows as an error", async ({ app: page, editor }) => {
  const before = editor.read();
  await fit(page);
  await selectRule(page, 'ReviewRequired');
  await page.getByRole('button', { name: 'Remove read cappedBonusCents' }).click();

  await receipt(page, 'Removed read cappedBonusCents from ReviewRequired');
  await receipt(page, '1 use remains in its body');
  expect(changedLines(before, editor.read())).toEqual([{
    line: 188,
    before: reviewBefore,
    after: 'func ReviewRequired(approvalsSatisfied bool) (reviewRequired *string) {',
  }]);
  const node = page.locator('#graph-root [data-rule="ReviewRequired"]');
  await expect(node).toHaveClass(/error/);
  await expect(node.locator('.note')).toContainText('undefined: cappedBonusCents');
  await expect(page.locator('#code-root .code-edit .cm-mark-error')).toHaveCount(1);
  await expect(page.locator('#code-root .code-edit .cm-line', { hasText: 'cappedBonusCents > 0' })).toBeVisible();
});

test('item 3: removing a read the body does not use leaves a valid ruleset', async ({ app: page, editor }) => {
  const before = editor.read();
  await fit(page);
  await dragFactOntoRule(page, 'financeRequired', 'ReviewRequired');
  await receipt(page, 'Added read financeRequired bool to ReviewRequired');
  await expect(page.locator('#sheet-root .sheet-name')).toHaveText('ReviewRequired()');
  await page.getByRole('button', { name: 'Remove read financeRequired' }).click();
  await receipt(page, 'Removed read financeRequired from ReviewRequired');
  expect(editor.read()).toBe(before);
  await expect(page.locator('#summary')).toContainText('0 errors');
  await expect(page.locator('#graph-root [data-rule="ReviewRequired"]')).not.toHaveClass(/error/);
});

test('item 4: a drop that would close a cycle is refused with the path shown, and the file is unchanged', async ({ app: page, editor }) => {
  const before = editor.read();
  await fit(page);
  await pickUp(page, factRow(page, 'approvalsSatisfied'));
  await moveOver(page, nodeBox(page, 'CappedBonus'));

  const refusal = 'No drop here. It would create a cycle through FinanceRequired and ApprovalsSatisfied.';
  await expect(page.locator('#status')).toContainText(refusal);
  await expect(page.locator('#graph-root [data-rule="CappedBonus"]')).toHaveClass(/refused/);
  await expect(page.locator('#graph-root .closing-wire')).toHaveCount(1);
  // The sheet lists the path, one wire per line.
  const gesture = page.locator('#sheet-root .sheet-gesture');
  await expect(gesture).toContainText('approvalsSatisfied already depends on CappedBonus');
  for (const step of ['CappedBonus → cappedBonusCents', 'FinanceRequired → financeRequired', 'ApprovalsSatisfied → approvalsSatisfied']) {
    await expect(gesture).toContainText(step);
  }
  await expect(gesture).toContainText('Remove one of these wires first');
  // Rules that could never be a target are not offered. The preview shows no pending edit.
  await expect(page.locator('#code-root .code-preview .cm-ins')).toHaveCount(0);
  expect(editor.read()).toBe(before);

  await page.mouse.up();
  await expect(page.locator('#status')).toContainText(refusal);
  expect(editor.read()).toBe(before);
  await expect(page.locator('#undo')).toBeDisabled();
  await expect(page.locator('#summary')).toContainText('0 errors');
});
