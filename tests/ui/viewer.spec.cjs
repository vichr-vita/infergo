const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

const url = name => pathToFileURL(resolve(`.view-test/${name}.html`)).href;

async function fits(page) {
  const issues = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return [...document.querySelectorAll('main, header, .toolbar, .summary, #rule-list li, #inspector, #inspector pre, #inspector .fact-value')]
      .filter(el => el.getBoundingClientRect().width)
      .filter(el => el.getBoundingClientRect().right > width + 1 || el.getBoundingClientRect().left < -1 || el.scrollWidth > el.clientWidth + 1)
      .map(el => `${el.tagName}#${el.id}.${el.className}`);
  });
  expect(issues).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test('offline graph, values, source, producer links, history, search, and zoom', async ({ page }) => {
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.goto(url('bonus'));
  await expect(page.locator('#rule-title')).toHaveText('FinalBonus()');
  await expect(page.locator('#outputs')).toContainText('1,049,000 c');
  await expect(page.locator('#source')).toContainText('func FinalBonus(');
  await expect(page.locator('#diagram .rule-node')).toHaveCount(26);
  await expect(page.locator('#diagram .edge-label').first()).not.toBeEmpty();
  const svg = page.locator('#diagram');
  const width = Number(await svg.getAttribute('width'));
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  expect(Number(await svg.getAttribute('width'))).toBeGreaterThan(width);
  await page.getByRole('button', { name: 'Actual size' }).click();
  const node = page.locator('.rule-node[data-rule="ApprovalsSatisfied"]');
  await node.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#rule-title')).toHaveText('ApprovalsSatisfied()');
  await page.locator('#case-select').selectOption('finance-pending');
  await expect(page.locator('#rule-status')).toHaveText('Succeeded');
  await expect(page.locator('#outputs')).toContainText('false');
  await page.locator('#inputs').getByRole('link', { name: '← FinanceRequired()' }).click();
  await expect(page.locator('#rule-title')).toHaveText('FinanceRequired()');
  await page.goBack();
  await expect(page.locator('#rule-title')).toHaveText('ApprovalsSatisfied()');
  await page.reload();
  await expect(page.locator('#case-select')).toHaveValue('finance-pending');
  await expect(page.locator('#rule-title')).toHaveText('ApprovalsSatisfied()');
  await page.locator('#rule-search').fill('paymentReference');
  await expect(page.locator('#rule-title')).toHaveText('PaymentReference()');
  await expect(page.locator('#search-results')).toHaveText('1 matching rules');
  await expect(page.locator('#diagram .search-match')).toHaveCount(1);
  await page.locator('#rule-search').fill('');
  await page.locator('#case-select').selectOption('invalid-role');
  await page.locator('#rule-select').selectOption('RoleRate');
  await expect(page.locator('#evaluation-error')).toContainText('unknown role');
  await expect(page.locator('#rule-status')).toContainText('Failed. unknown role');
  await expect(page.locator('#outputs')).toContainText('Unavailable');
  await page.locator('#rule-select').selectOption('BaseBonus');
  await expect(page.locator('#rule-status')).toHaveText('Not run');
  await fits(page);
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
});

for (const width of [320, 390, 667]) {
  test(`mobile ${width}px preserves populated, long, and open source content`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 667 ? 390 : 844 });
    await page.goto(url('bonus'));
    await expect(page.locator('#diagram-viewport')).toBeHidden();
    await expect(page.locator('#rule-list')).toBeVisible();
    await expect(page.locator('#rule-list > li')).toHaveCount(5);
    await fits(page);
    await page.locator('#rule-search').fill('PaymentReference');
    await expect(page.locator('#rule-list > li')).toHaveCount(1);
    await page.locator('#rule-list > li > a').click();
    await expect(page.locator('#rule-title')).toHaveText('PaymentReference()');
    await page.locator('#source-panel').evaluate(el => { el.open = true; });
    await fits(page);
    await page.getByRole('link', { name: 'Return to map' }).click();
    await expect(page.locator('#rule-list > li > a')).toBeFocused();
    await page.goto(url('long'));
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    await expect(page.locator('img')).toHaveCount(0);
    await fits(page);
    const longName = await page.locator('#rule-select option').first().getAttribute('value');
    await page.locator('#rule-select').selectOption(longName);
    await page.locator('#source-panel').evaluate(el => { el.open = true; });
    await fits(page);
    await page.locator('#rule-select').selectOption('PaymentReference');
    await expect(page.locator('#outputs')).toContainText('BONUS-LongReference');
    await fits(page);
    await page.locator('#case-select').selectOption('invalid-role');
    await fits(page);
  });
}

test('topology, empty graph, and malformed links remain usable', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url('topology') + '#case=missing&rule=missing');
  await expect(page.locator('#case-select')).toHaveValue('');
  await expect(page.locator('#rule-status')).toHaveText('Not evaluated');
  await expect(page.locator('#outputs')).toContainText('Not evaluated');
  await page.goto(url('empty'));
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#inspector')).toBeHidden();
  await expect(page.locator('#rule-select')).toBeDisabled();
  expect(errors).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`parallel fact edges retain finite geometry and inspection at ${width}px`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url('parallel'));
    await expect(page.locator('#rule-title')).toHaveText('Rule3()');
    await expect(page.locator('#diagram .rule-node')).toHaveCount(4);
    await expect(page.locator('#diagram .edge')).toHaveCount(7);
    await expect(page.locator('#diagram .edge-label')).toHaveCount(7);
    const geometry = await page.locator('#diagram').evaluate(diagram => {
      const { width, height } = diagram.viewBox.baseVal;
      const inside = point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height;
      return {
        bounds: Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0,
        nodes: [...diagram.querySelectorAll('.rule-node rect, .edge-label rect')].every(rect => {
          const x = Number(rect.getAttribute('x')), y = Number(rect.getAttribute('y'));
          const w = Number(rect.getAttribute('width')), h = Number(rect.getAttribute('height'));
          return w > 0 && h > 0 && inside({ x, y }) && inside({ x: x + w, y: y + h });
        }),
        paths: [...diagram.querySelectorAll('.edge')].every(path => {
          const points = [...path.getAttribute('d').matchAll(/[ML]([^, ]+),([^ ]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
          return points.length >= 2 && points.every(inside) && path.getTotalLength() > 0;
        }),
      };
    });
    expect(geometry).toEqual({ bounds: true, nodes: true, paths: true });
    await page.locator('#case-select').selectOption('second');
    await expect(page.locator('#outputs')).toContainText('2');
    await page.locator('#inputs').getByRole('link', { name: '← Rule1()' }).click();
    await expect(page.locator('#rule-title')).toHaveText('Rule1()');
    await expect(page.locator('#source')).toContainText('func Rule1()');
    await page.locator('#rule-select').selectOption('Rule2');
    await expect(page.locator('#inputs li')).toHaveCount(4);
    await expect(page.locator('#inputs')).toContainText('fact1');
    await expect(page.locator('#inputs')).toContainText('fact2');
    await expect(page.locator('#inputs')).toContainText('fact3');
    await fits(page);
    expect(errors).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  for (const fault of ['throw', 'bounds', 'node', 'edge']) {
    test(`layout ${fault} failure preserves inspection at ${width}px`, async ({ page }) => {
      const errors = [];
      const diagnostics = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url(`layout-${fault}`));
      await expect(page.locator('#layout-error')).toBeVisible();
      await expect(page.locator('#layout-error')).toContainText('diagram could not be drawn');
      await expect(page.locator('#evaluation-error')).toBeHidden();
      await expect(page.locator('#diagram-viewport')).toBeHidden();
      await expect(page.locator('#diagram .rule-node, #diagram .edge')).toHaveCount(0);
      await expect(page.locator('#diagram-fit')).toBeDisabled();
      await expect(page.locator('#rule-list')).toBeVisible();
      await expect(page.locator('#rule-title')).toHaveText('Rule3()');
      await expect(page.locator('#rule-status')).toHaveText('Succeeded');
      await page.locator('#case-select').selectOption('second');
      await expect(page.locator('#outputs')).toContainText('2');
      await page.locator('#inputs').getByRole('link', { name: '← Rule1()' }).click();
      await expect(page.locator('#source')).toContainText('func Rule1()');
      await page.locator('#rule-search').fill('Rule2');
      await expect(page.locator('#rule-list > li')).toHaveCount(1);
      await page.locator('#rule-list > li > a').click();
      await expect(page.locator('#rule-title')).toHaveText('Rule2()');
      await expect(page.locator('#inputs li')).toHaveCount(4);
      await fits(page);
      expect(errors).toEqual([]);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain('Rule dependency diagram unavailable.');
    });
  }
}
