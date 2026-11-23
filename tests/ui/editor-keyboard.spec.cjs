// Keyboard only. These tests never use the pointer: elements get focus with
// focus() (the keyboard's Tab would only walk to the same place) and every
// action after that is a key press.
const { test, expect, changedLines, factRow, receipt } = require('./editor-fixture.cjs');

test.describe.configure({ timeout: 60_000 });

const node = (page, rule) => page.locator(`#graph-root [data-rule="${rule}"]`);

/** Presses a key until the status line or live region shows the text, up to a few steps. */
async function pressUntil(page, key, text, { limit = 12 } = {}) {
  for (let step = 0; step < limit; step++) {
    await page.keyboard.press(key);
    await expect(page.locator('#status, #announcer').first()).toBeAttached();
    const shown = await page.evaluate(() => `${document.querySelector('#status').textContent}\n${document.querySelector('#announcer').textContent}`);
    if (shown.includes(text)) return;
  }
  throw new Error(`${key} never reached ${JSON.stringify(text)}`);
}

test('item 11: W, arrow keys, and Enter wire a fact into a rule', async ({ app: page, editor }) => {
  const before = editor.read();
  await node(page, 'FinanceRequired').focus();
  await page.keyboard.press('w');
  await expect(page.locator('#status')).toContainText('Holding financeRequired bool');
  await pressUntil(page, 'ArrowRight', 'Drop to add financeRequired bool to ReviewRequired');
  expect(editor.read()).toBe(before);
  await expect(page.locator('#code-root .code-preview .cm-ins')).toHaveText(', financeRequired bool');
  await page.keyboard.press('Enter');
  await receipt(page, 'Added read financeRequired bool to ReviewRequired');
  const changes = changedLines(before, editor.read());
  expect(changes).toHaveLength(1);
  expect(changes[0].after).toContain('approvalsSatisfied bool, financeRequired bool)');
  await expect(page.locator('#graph-root .graph-wire[data-wire="FinanceRequired>financeRequired>ReviewRequired"]')).toHaveCount(1);
});

test('item 11: Esc puts a held fact down without writing', async ({ app: page, editor }) => {
  const before = editor.read();
  await node(page, 'FinanceRequired').focus();
  await page.keyboard.press('w');
  await pressUntil(page, 'ArrowRight', 'Drop to add financeRequired bool to');
  await page.keyboard.press('Escape');
  await expect(page.locator('#status')).not.toContainText('Holding');
  await page.keyboard.press('Enter');
  expect(editor.read()).toBe(before);
});

test('item 11: selecting a wire with the arrow keys and pressing Delete unwires it', async ({ app: page, editor }) => {
  const before = editor.read();
  await node(page, 'ReviewRequired').focus();
  // Shift and Up selects the first wire into the rule. Left and Right step through the others.
  await page.keyboard.press('Shift+ArrowUp');
  await pressUntil(page, 'ArrowRight', 'Wire approvalsSatisfied from ApprovalsSatisfied to ReviewRequired. Delete removes it.', { limit: 4 });
  await page.keyboard.press('Delete');
  await receipt(page, 'Removed read approvalsSatisfied from ReviewRequired');
  const changes = changedLines(before, editor.read());
  expect(changes).toHaveLength(1);
  expect(changes[0].after).toBe('func ReviewRequired(cappedBonusCents uint64) (reviewRequired *string) {');
});

test('item 11: Delete on a read in the sheet unwires it', async ({ app: page, editor }) => {
  const before = editor.read();
  await node(page, 'ReviewRequired').focus();
  await page.keyboard.press(' ');
  await expect(page.locator('#sheet-root .sheet-name')).toHaveText('ReviewRequired()');
  await page.locator('#sheet-root .sheet-fact[aria-label^="Reads cappedBonusCents"]').focus();
  await page.keyboard.press('Delete');
  await receipt(page, 'Removed read cappedBonusCents from ReviewRequired');
  expect(changedLines(before, editor.read())).toHaveLength(1);
  expect(editor.read()).toContain('func ReviewRequired(approvalsSatisfied bool) (reviewRequired *string) {');
});

test('item 11: A opens the Add read picker, and the arrow keys and Enter wire the chosen fact', async ({ app: page, editor }) => {
  const before = editor.read();
  await node(page, 'ReviewRequired').focus();
  await page.keyboard.press('a');
  const picker = page.locator('#sheet-root').getByRole('combobox');
  await expect(picker).toBeFocused();
  await page.keyboard.type('financeReq');
  await expect(page.locator('#sheet-root').getByRole('option')).toHaveCount(1);
  await expect(page.locator('#sheet-root').getByRole('option').first()).toContainText('financeRequired');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await receipt(page, 'Added read financeRequired bool to ReviewRequired');
  expect(changedLines(before, editor.read())).toHaveLength(1);
});

test('item 11: F2 renames a fact and a rule', async ({ app: page, editor }) => {
  await factRow(page, 'finalBonusCents').focus();
  await page.keyboard.press('F2');
  await expect(page.locator('.inline-input')).toBeFocused();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('finalPayoutCents');
  await page.keyboard.press('Enter');
  await receipt(page, 'Renamed fact finalBonusCents to finalPayoutCents');
  expect(editor.read()).toContain('(finalPayoutCents uint64)');
  expect(editor.read('facts.go')).toContain('fact:"finalPayoutCents"');

  await node(page, 'TenureEligible').focus();
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: 'Rename rule TenureEligible' })).toBeFocused();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('TenureOK');
  await page.keyboard.press('Enter');
  await receipt(page, 'Renamed rule TenureEligible to TenureOK');
  expect(editor.read()).toContain('// TenureOK requires at least 12 months of service. BR-03.\nfunc TenureOK(');
  await expect(node(page, 'TenureOK')).toHaveCount(1);
});

test('item 11: N creates a rule and Enter confirms it', async ({ app: page, editor }) => {
  const before = editor.read();
  await node(page, 'CappedBonus').focus();
  await page.keyboard.press('n');
  await expect(page.locator('.graph-new-rule input').first()).toBeFocused();
  await page.keyboard.type('KeyboardRule');
  await page.keyboard.press('Enter');
  await receipt(page, 'Added rule KeyboardRule');
  const after = editor.read();
  expect(after).toContain('// KeyboardRule TODO: state the requirement.\nfunc KeyboardRule(');
  expect(after.length).toBeGreaterThan(before.length);
  await expect(page.locator('#graph-root .graph-node')).toHaveCount(27);
  editor.run('go', ['build', './...']);
});

test('item 11: a rule can be created right after another one was renamed', async ({ app: page, editor }) => {
  await node(page, 'TenureEligible').focus();
  await page.keyboard.press('F2');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('TenureOK');
  await page.keyboard.press('Enter');
  await receipt(page, 'Renamed rule TenureEligible to TenureOK');
  await expect(page.locator('#summary')).toContainText('Evaluator updated');

  await node(page, 'TenureOK').focus();
  await page.keyboard.press('n');
  const name = page.locator('.graph-new-rule input').first();
  await expect(name).toBeFocused();
  // The form must keep focus. A late redraw that moves it back to the rule would send the typing to the graph.
  await page.waitForTimeout(1200);
  await expect(name).toBeFocused();
  await page.keyboard.type('KeyboardRule');
  await page.keyboard.press('Enter');
  await receipt(page, 'Added rule KeyboardRule');
  expect(editor.read()).toContain('func KeyboardRule(');
});
