// Structural edits: rename a fact, create and delete rules, reword a requirement.
const { test, expect, commentLines, fit, factRow, pickUp, moveOverEmptyCanvas, selectRule, receipt } = require('./editor-fixture.cjs');

test.describe.configure({ timeout: 60_000 });

const summary = page => page.locator('#summary');

test('item 7: renaming a fact updates its producer, its readers, their bodies, and the contract tag', async ({ app: page, editor }) => {
  const before = editor.read();
  const factsBefore = editor.read('facts.go');
  expect(before.match(/finalBonusCents/g)).toHaveLength(6);

  await factRow(page, 'finalBonusCents').focus();
  await page.keyboard.press('F2');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('finalPayoutCents');
  await page.keyboard.press('Enter');
  await receipt(page, 'Renamed fact finalBonusCents to finalPayoutCents in 3 rules and the Outputs tag');
  await receipt(page, 'bonus.go +6 −6, facts.go +1 −1');

  const after = editor.read();
  expect(after).not.toContain('finalBonusCents');
  expect(after.match(/finalPayoutCents/g)).toHaveLength(6);
  expect(after).toContain('(finalPayoutCents uint64) {');                                 // producer, FinalBonus
  expect(after).toContain('func PaymentReady(finalPayoutCents uint64)');                   // reader parameter
  expect(after).toContain('if finalPayoutCents > 0 {\n\t\treturn &finalPayoutCents');      // reader body
  expect(after).toContain('func TotalCompensation(salaryCents uint64, finalPayoutCents uint64)');
  expect(after).toContain('return sum(salaryCents, finalPayoutCents)');
  expect(after).toContain('// FinalBonus releases the capped bonus only when approvals pass. BR-22.');
  // The contract tag changes, and the Go field name does not.
  const facts = editor.read('facts.go');
  expect(facts).toContain('FinalBonusCents        uint64  `fact:"finalPayoutCents"`');
  expect(facts).not.toContain('fact:"finalBonusCents"');
  expect(facts.replace('finalPayoutCents', 'finalBonusCents')).toBe(factsBefore);
  expect(commentLines(after)).toEqual(commentLines(before));
  expect(editor.gofmtList('bonus.go', 'facts.go')).toBe('');

  // The page follows: the fact is renamed in the Facts column and on the nodes.
  await expect(factRow(page, 'finalPayoutCents')).toBeVisible();
  await expect(page.locator('#facts-root .fact-row[aria-label^="finalBonusCents "]')).toHaveCount(0);
  await expect(page.locator('#graph-root [data-rule="PaymentReady"]')).toHaveAttribute('aria-label', /Reads finalPayoutCents uint64\./);
  await expect(summary(page)).toContainText('0 errors');
  editor.run('go', ['build', './...']);
});

test('item 7: renaming a fact that is not in a contract leaves both contracts alone', async ({ app: page, editor }) => {
  const factsBefore = editor.read('facts.go');
  await factRow(page, 'bonusEligible').focus();
  await page.keyboard.press('F2');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('eligibleForBonus');
  await page.keyboard.press('Enter');
  await receipt(page, 'Renamed fact bonusEligible to eligibleForBonus in 2 rules');
  expect(editor.read()).not.toContain('bonusEligible');
  expect(editor.read('facts.go')).toBe(factsBefore);
  await expect(summary(page)).toContainText('0 errors');
  editor.run('go', ['build', './...']);
});

test('item 8: dropping a fact on empty canvas creates a stub rule, and deleting the rule removes it', async ({ app: page, editor }) => {
  const before = editor.read();
  await fit(page);
  await pickUp(page, factRow(page, 'cappedBonusCents'));
  await moveOverEmptyCanvas(page);
  await expect(page.locator('#status')).toContainText('Holding cappedBonusCents uint64');
  await page.mouse.up();

  // The inline form opens at the drop point with the fact as the rule's read.
  const form = page.getByRole('form', { name: 'New rule' });
  await expect(form).toBeVisible();
  await expect(form).toContainText('+ cappedBonusCents uint64');
  await form.getByLabel('Rule name').fill('LoyaltyTopUp');
  await expect(form.getByLabel('Result name')).toHaveValue('loyaltyTopUp');
  expect(editor.read()).toBe(before);
  await page.keyboard.press('Enter');
  await receipt(page, 'Added rule LoyaltyTopUp');

  const stub = [
    '// LoyaltyTopUp TODO: state the requirement.',
    'func LoyaltyTopUp(cappedBonusCents uint64) (loyaltyTopUp uint64, err error) {',
    '\treturn loyaltyTopUp, errors.New("LoyaltyTopUp is not implemented")',
    '}',
    '',
  ].join('\n');
  const after = editor.read();
  expect(after).toContain(stub);
  // It lands right after the producer of the fact it reads.
  expect(after.indexOf('func CappedBonus(')).toBeLessThan(after.indexOf(stub));
  expect(after.indexOf(stub)).toBeLessThan(after.indexOf('func FinanceRequired('));
  expect(after.replace(`${stub}\n`, '')).toBe(before);
  expect(editor.gofmtList('bonus.go')).toBe('');
  await expect(page.locator('#graph-root .graph-node')).toHaveCount(27);
  await expect(page.locator('#graph-root .graph-wire[data-wire="CappedBonus>cappedBonusCents>LoyaltyTopUp"]')).toHaveCount(1);
  await expect(page.locator('#sheet-root .sheet-name')).toHaveText('LoyaltyTopUp()');
  // No output needs it yet, so the compiler warns and the rest of the ruleset stays valid.
  await expect(summary(page)).toContainText('27 rules');
  await expect(summary(page)).toContainText('1 warning');
  await expect(summary(page)).toContainText('0 errors');
  editor.run('go', ['build', './...']);

  // Deleting it asks once, then removes the comment and the declaration.
  await page.getByRole('button', { name: 'Delete rule' }).click();
  await expect(page.locator('#sheet-root .sheet-title-host')).toContainText('Delete LoyaltyTopUp? Its doc comment and declaration are removed from bonus.go.');
  expect(editor.read()).toBe(after);
  await page.locator('#sheet-root .sheet-title-host').getByRole('button', { name: 'Delete LoyaltyTopUp' }).click();
  await receipt(page, 'Deleted rule LoyaltyTopUp');
  expect(editor.read()).toBe(before);
  await expect(page.locator('#graph-root .graph-node')).toHaveCount(26);
  await expect(summary(page)).toContainText('0 warnings');
});

test('item 8: Keep in the delete question leaves the rule alone', async ({ app: page, editor }) => {
  const before = editor.read();
  await selectRule(page, 'TenureAward');
  await page.getByRole('button', { name: 'Delete rule' }).click();
  await page.getByRole('button', { name: 'Keep' }).click();
  expect(editor.read()).toBe(before);
  await expect(page.locator('#graph-root .graph-node')).toHaveCount(26);
});

test('item 9: editing the requirement text rewrites the doc comment on disk', async ({ app: page, editor }) => {
  const before = editor.read();
  await selectRule(page, 'TenureAward');
  await page.locator('#sheet-root .sheet-requirement').click();
  const field = page.getByRole('textbox', { name: 'Requirement of TenureAward' });
  await expect(field).toBeFocused();
  await field.fill('TenureAward adds 60,000 cents for at least 36 months of service, and this sentence is long enough to need wrapping across lines. BR-15.');
  await page.keyboard.press('Enter');
  await receipt(page, 'Rewrote the requirement of TenureAward');
  await receipt(page, 'bonus.go +2 −1');

  const after = editor.read();
  expect(after).toContain([
    '// TenureAward adds 60,000 cents for at least 36 months of service, and this',
    '// sentence is long enough to need wrapping across lines. BR-15.',
    'func TenureAward(tenureMonths uint16) (tenureAwardCents uint64) {',
  ].join('\n'));
  expect(after).not.toContain('adds 50,000 cents for at least 36 months');
  // The rewritten comment wraps at 80 columns. (Other lines of the file are longer and stay as they were.)
  for (const line of after.split('\n').filter(line => line.startsWith('// ') && !before.includes(line))) expect(line.length).toBeLessThanOrEqual(80);
  expect(after.split('\n').length).toBe(before.split('\n').length + 1);
  expect(editor.gofmtList('bonus.go')).toBe('');
  await expect(page.locator('#sheet-root .sheet-requirement')).toContainText('adds 60,000 cents');
  await expect(page.locator('#graph-root [data-rule="TenureAward"]')).toContainText('60,000');
  await expect(page.locator('#code-root .code-edit .cm-content')).toContainText('// sentence is long enough');
  await expect(summary(page)).toContainText('0 errors');
});

test('item 9: Esc leaves the requirement alone', async ({ app: page, editor }) => {
  const before = editor.read();
  await selectRule(page, 'TenureAward');
  await page.locator('#sheet-root .sheet-requirement').click();
  await page.getByRole('textbox', { name: 'Requirement of TenureAward' }).fill('Something else.');
  await page.keyboard.press('Escape');
  await expect(page.locator('#sheet-root .sheet-requirement')).toContainText('adds 50,000 cents');
  expect(editor.read()).toBe(before);
});

test('contracts: adding an input and requesting an output by drop edit the structs, and removing both restores facts.go', async ({ app: page, editor }) => {
  const before = editor.read('facts.go');
  await page.locator('#facts-root .facts-inputs button[aria-label="Add input"]').click();
  await page.locator('#facts-root .facts-host input').first().fill('loyaltyYears');
  await page.locator('#facts-root .facts-host input').nth(1).fill('uint8');
  await page.locator('#facts-root .facts-host').getByRole('button', { name: 'Add input' }).click();
  await receipt(page, 'Added input loyaltyYears uint8');
  expect(editor.read('facts.go')).toContain('\tLoyaltyYears        uint8      `fact:"loyaltyYears"`\n');
  await expect(page.locator('#summary')).toContainText('15 inputs');
  expect(editor.gofmtList('facts.go')).toBe('');

  // Drag a produced fact from its node onto the Outputs section.
  await fit(page);
  const source = page.locator('#graph-root [data-rule="CappedBonus"] .graph-fact.produce');
  const box = await source.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 40, box.y, { steps: 5 });
  const outputs = await page.locator('#facts-root .facts-outputs').boundingBox();
  await page.mouse.move(outputs.x + outputs.width / 2, outputs.y + outputs.height / 2, { steps: 15 });
  await page.mouse.up();
  await receipt(page, 'Requested output cappedBonusCents uint64');
  expect(editor.read('facts.go')).toContain('\tCappedBonusCents       uint64  `fact:"cappedBonusCents"`\n');
  await expect(page.locator('#summary')).toContainText('6 requested outputs');

  // Stop requesting it, then take the new input out again: the file is as it began.
  await page.locator('#facts-root .facts-outputs .fact-row[aria-label^="cappedBonusCents "]').focus();
  await page.keyboard.press('Delete');
  await receipt(page, 'Stopped requesting output cappedBonusCents');
  await page.locator('#facts-root .facts-inputs .fact-row[aria-label^="loyaltyYears "]').focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('#summary')).toContainText('14 inputs');
  expect(editor.read('facts.go')).toBe(before);
});

// WebKit does not submit a form from a field with a datalist on its own.
test('contracts: Enter in the Go type field submits the Add input form', async ({ app: page, editor }) => {
  await page.locator('#facts-root .facts-inputs button[aria-label="Add input"]').click();
  await page.locator('#facts-root .facts-host input').first().fill('loyaltyYears');
  await page.locator('#facts-root .facts-host input').nth(1).fill('uint8');
  await page.keyboard.press('Enter');
  await receipt(page, 'Added input loyaltyYears uint8');
  expect(editor.read('facts.go')).toContain('`fact:"loyaltyYears"`');
});
