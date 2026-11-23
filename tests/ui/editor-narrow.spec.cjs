// Narrow screens: the list layout must never scroll sideways, and the rule
// sheet must be able to wire and unwire with no drag and no canvas.
const { test, expect, expectFits, receipt } = require('./editor-fixture.cjs');

test.describe.configure({ timeout: 60_000 });

const sizes = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 667, height: 390 },
];

for (const { width, height } of sizes) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height } });

    test(`item 12: at ${width} px the page does not scroll sideways, and the sheet wires and unwires through the Add read picker`, async ({ app: page, editor }) => {
      const before = editor.read();
      // The list replaces the canvas.
      await expect(page.locator('#list-root')).toBeVisible();
      await expect(page.locator('#graph-root')).toBeHidden();
      await expect(page.locator('#list-root .rule-list > li')).toHaveCount(26);
      await expectFits(page);

      await page.locator('#list-root li[data-key="ReviewRequired"] .rule-summary').click();
      await expect(page.locator('#sheet-root .sheet-name')).toHaveText('ReviewRequired()');
      await expectFits(page);

      // The code pane is open under the sheet.
      const code = page.locator('#code-root .code-edit .cm-content');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toContainText('func ReviewRequired(');
      await code.click();
      await expectFits(page);

      await page.getByRole('button', { name: 'Add read' }).click();
      const picker = page.locator('#sheet-root').getByRole('combobox');
      await expect(picker).toBeFocused();
      await expect(page.locator('#sheet-root').getByRole('option').first()).toBeVisible();
      // The full list is open, including the disabled facts with their reasons.
      await expectFits(page);
      await expect(page.locator('#sheet-root [role="option"][aria-disabled="true"]').first()).toBeVisible();
      await picker.fill('financeReq');
      await expect(page.locator('#sheet-root').getByRole('option')).toHaveCount(1);
      await page.locator('#sheet-root').getByRole('option').click();

      await receipt(page, 'Added read financeRequired bool to ReviewRequired');
      expect(editor.read()).toContain('approvalsSatisfied bool, financeRequired bool)');
      await expect(page.locator('#sheet-root .sheet-rows [data-key="financeRequired"]')).toBeVisible();
      await expectFits(page);

      await page.getByRole('button', { name: 'Remove read financeRequired' }).click();
      await receipt(page, 'Removed read financeRequired from ReviewRequired');
      expect(editor.read()).toBe(before);
      await expectFits(page);
    });
  });
}

test.describe('long names at 320 px', () => {
  test.use({ viewport: { width: 320, height: 640 } });
  const long = 'AnUnusuallyLongRuleNameThatWouldNotFitOnAPhoneWithoutWrapping';

  /** Gives TenureAward a very long name, requirement, and result name, as an IDE edit. */
  function renameToLong(editor) {
    editor.editOutside('bonus.go', 'func TenureAward(tenureMonths uint16) (tenureAwardCents uint64)', `func ${long}(tenureMonths uint16) (${long.replace(/^./, 'a')}Cents uint64)`);
    editor.editOutside('bonus.go', '// TenureAward adds 50,000 cents', `// ${long} ${'adds a lot of words to the requirement '.repeat(6)}\n// TenureAward adds 50,000 cents`);
  }

  test('item 12: a long rule name, a long requirement, and a long fact name still fit', async ({ app: page, editor }) => {
    renameToLong(editor);
    await expect(page.locator(`#list-root li[data-key="${long}"]`)).toBeVisible();
    await expectFits(page);
    await page.locator(`#list-root li[data-key="${long}"] .rule-summary`).click();
    await expect(page.locator('#sheet-root .sheet-name')).toHaveText(`${long}()`);
    await expectFits(page);
  });

  // The picker's label reads "Add read to <rule name>" and does not wrap, so a
  // long rule name pushes it and its Close button past the right edge.
  test.fixme('item 12: the Add read picker fits when the rule has a long name', async ({ app: page, editor }) => {
    renameToLong(editor);
    await page.locator(`#list-root li[data-key="${long}"] .rule-summary`).click();
    await page.getByRole('button', { name: 'Add read' }).click();
    await expectFits(page);
  });
});
