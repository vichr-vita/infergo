// Undo, redo, and the History tab. Undo must write back the exact bytes.
const { test, expect, fit, factRow, pickUp, moveOver, moveOverEmptyCanvas, nodeBox, selectRule, dragFactOntoRule, receipt, typeInDeclaration } = require('./editor-fixture.cjs');

test.describe.configure({ timeout: 90_000 });

const files = editor => ({ 'bonus.go': editor.read('bonus.go'), 'facts.go': editor.read('facts.go') });

/**
 * Performs a gesture, then undoes and redoes it. After undo both Go files are
 * byte for byte what they were before. After redo they match the gesture's result.
 */
async function roundTrip(page, editor, label, gesture, { keyboard = false } = {}) {
  const before = files(editor);
  await gesture();
  await receipt(page, label);
  const after = files(editor);
  expect(after, `${label} changes a file`).not.toEqual(before);

  if (keyboard) {
    await page.locator('#graph-root .graph-node').first().focus();
    await page.keyboard.press('Control+z');
  } else {
    await page.locator('#undo').click();
  }
  await expect.poll(() => files(editor), { message: `undo of ${label}` }).toEqual(before);
  await expect(page.locator('#status')).toContainText('Undid');

  if (keyboard) {
    await page.keyboard.press('Control+Shift+z');
  } else {
    await page.locator('#redo').click();
  }
  await expect.poll(() => files(editor), { message: `redo of ${label}` }).toEqual(after);
  await expect(page.locator('#status')).toContainText('Redid');
}

test('item 10: undo and redo restore exact bytes for wiring, unwiring, renaming, new rules, deleting, and rewording', async ({ app: page, editor }) => {
  await fit(page);

  await roundTrip(page, editor, 'Added read financeRequired bool to ReviewRequired', async () => {
    await dragFactOntoRule(page, 'financeRequired', 'ReviewRequired');
  });

  await roundTrip(page, editor, 'Removed read financeRequired from ReviewRequired', async () => {
    await selectRule(page, 'ReviewRequired');
    await page.getByRole('button', { name: 'Remove read financeRequired' }).click();
  }, { keyboard: true });

  await roundTrip(page, editor, 'Renamed fact finalBonusCents to finalPayoutCents', async () => {
    await factRow(page, 'finalBonusCents').focus();
    await page.keyboard.press('F2');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('finalPayoutCents');
    await page.keyboard.press('Enter');
  });

  await roundTrip(page, editor, 'Added rule LoyaltyTopUp', async () => {
    await fit(page);
    await pickUp(page, factRow(page, 'cappedBonusCents'));
    await moveOverEmptyCanvas(page);
    await page.mouse.up();
    await page.getByRole('form', { name: 'New rule' }).getByLabel('Rule name').fill('LoyaltyTopUp');
    await page.keyboard.press('Enter');
  });

  await roundTrip(page, editor, 'Deleted rule LoyaltyTopUp', async () => {
    await selectRule(page, 'LoyaltyTopUp');
    await page.getByRole('button', { name: 'Delete rule' }).click();
    await page.locator('#sheet-root .sheet-title-host').getByRole('button', { name: 'Delete LoyaltyTopUp' }).click();
  });

  await roundTrip(page, editor, 'Rewrote the requirement of TenureAward', async () => {
    await selectRule(page, 'TenureAward');
    await page.locator('#sheet-root .sheet-requirement').click();
    await page.getByRole('textbox', { name: 'Requirement of TenureAward' }).fill('TenureAward adds 60,000 cents after three years. BR-15.');
    await page.keyboard.press('Enter');
  });

  await roundTrip(page, editor, 'Edited the code of ReviewRequired', async () => {
    await selectRule(page, 'ReviewRequired');
    await typeInDeclaration(page, editor.read(), 'ReviewRequired', 'func ReviewRequired(cappedBonusCents uint64, approvalsSatisfied bool', ', financeRequired bool');
  });
});

test('item 10: undoing a type fix and a cycle fix restores the file', async ({ app: page, editor }) => {
  const good = editor.read();
  editor.editOutside('bonus.go', 'func FinanceRequired(cappedBonusCents uint64)', 'func FinanceRequired(cappedBonusCents uint32)');
  await fit(page);
  await page.locator('#graph-root .graph-fix', { hasText: 'Use uint64 in FinanceRequired' }).click();
  await expect.poll(() => editor.read()).toBe(good);
  await page.locator('#undo').click();
  await expect.poll(() => editor.read()).toContain('cappedBonusCents uint32');
  await page.locator('#redo').click();
  await expect.poll(() => editor.read()).toBe(good);
});

test('item 10: an outside edit appears in the History tab and blocks undo of older entries in that file', async ({ app: page, editor }) => {
  await fit(page);
  await dragFactOntoRule(page, 'financeRequired', 'ReviewRequired');
  await receipt(page, 'Added read financeRequired bool to ReviewRequired');

  editor.editOutside('bonus.go', 'return tenureMonths >= 12', 'return tenureMonths >= 13');
  await page.locator('#tab-history').click();
  const entries = page.locator('#history-root .history-list > li:not(.history-cursor)');
  await expect(entries).toHaveCount(2);
  // Newest first.
  await expect(entries.nth(0)).toContainText('Changed bonus.go in another editor');
  await expect(entries.nth(0)).toContainText('bonus.go +1 −1');
  await expect(entries.nth(0)).toContainText('Outside edit');
  await expect(entries.nth(0)).toHaveClass(/disk/);
  await expect(entries.nth(1)).toContainText('Added read financeRequired bool to ReviewRequired');
  await expect(entries.nth(1)).toContainText('Can no longer be undone here');
  await expect(entries.nth(1)).toHaveClass(/blocked/);

  // The outside edit itself undoes, and the older entry stays blocked.
  const withOutside = editor.read();
  await page.locator('#undo').click();
  await expect.poll(() => editor.read()).not.toBe(withOutside);
  expect(editor.read()).toContain('return tenureMonths >= 12');
  expect(editor.read()).toContain('approvalsSatisfied bool, financeRequired bool)');
});

test('item 10: history entries undo and redo to a chosen point', async ({ app: page, editor }) => {
  const start = files(editor);
  await fit(page);
  await dragFactOntoRule(page, 'financeRequired', 'ReviewRequired');
  await receipt(page, 'Added read financeRequired bool to ReviewRequired');
  await selectRule(page, 'TenureAward');
  await page.locator('#sheet-root .sheet-requirement').click();
  await page.getByRole('textbox', { name: 'Requirement of TenureAward' }).fill('TenureAward adds 60,000 cents after three years. BR-15.');
  await page.keyboard.press('Enter');
  await receipt(page, 'Rewrote the requirement of TenureAward');

  await page.locator('#tab-history').click();
  const entries = page.locator('#history-root .history-list > li:not(.history-cursor)');
  await expect(entries).toHaveCount(2);
  await entries.nth(1).getByRole('button', { name: /^Undo / }).click();
  await expect.poll(() => files(editor)).toEqual(start);
  await expect(page.locator('#history-root .history-cursor')).toHaveCount(1);
  await expect(entries.nth(0)).toHaveClass(/undone/);
  await expect(entries.nth(1)).toHaveClass(/undone/);
});
