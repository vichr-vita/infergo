// Start-up and security: the page that infergen edit serves for a copy of the
// bonus ruleset, and who may talk to its API.
const { request } = require('@playwright/test');
const { test, expect } = require('./editor-fixture.cjs');

test.describe.configure({ timeout: 60_000 });

test('item 1: the three-column page opens with all 26 rules', async ({ app: page, editor }) => {
  await expect(page.locator('#summary')).toContainText('26 rules · 14 inputs · 5 requested outputs');
  await expect(page.locator('#summary')).toContainText('0 errors · 0 warnings');
  await expect(page.locator('#summary')).toContainText('Evaluator current');
  await expect(page.locator('#graph-root .graph-node')).toHaveCount(26);
  await expect(page.locator('#facts-root .facts-inputs .count')).toHaveText('14');
  await expect(page.locator('#facts-root .facts-outputs .count')).toHaveText('5');
  await expect(page.locator('#facts-root .facts-derived .count')).toHaveText('26');
  await expect(page.locator('#facts-root .facts-inputs .fact-row')).toHaveCount(14);
  await expect(page.locator('#facts-root .facts-outputs .fact-row')).toHaveCount(5);
  await expect(page.locator('#package')).toHaveText('bonus');
  await expect(page.locator('#files')).toHaveText('bonus.go, facts.go');

  // Facts, graph, and rule sheet sit side by side in that order, from the same top edge.
  const [facts, graph, rule] = await Promise.all(['#facts-column', '#middle-column', '#rule-column'].map(id => page.locator(id).boundingBox()));
  expect(facts.x + facts.width).toBeLessThanOrEqual(graph.x + 1);
  expect(graph.x + graph.width).toBeLessThanOrEqual(rule.x + 1);
  expect(Math.abs(facts.y - graph.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(graph.y - rule.y)).toBeLessThanOrEqual(1);
  await expect(page.locator('#code-root .cm-editor').first()).toBeVisible();

  // Opening the page writes nothing.
  expect(editor.read()).toContain('func FinalBonus(');
  expect(editor.gofmtList('bonus.go', 'facts.go')).toBe('');
});

test('the API refuses requests without the session token, whichever origin sends them', async ({ app: page, editor }) => {
  const before = editor.read();
  // From the page's own origin, without the token the page was given.
  const fromPage = await page.evaluate(async () => {
    const model = await fetch('/api/model');
    const apply = await fetch('/api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: { op: 'delete_rule', rule: 'FinalBonus' } }) });
    return { model: model.status, apply: apply.status };
  });
  expect(fromPage).toEqual({ model: 401, apply: 401 });

  const client = await request.newContext();
  try {
    expect((await client.get(`${editor.origin}/api/model?token=wrong`)).status()).toBe(401);
    expect((await client.post(`${editor.origin}/api/apply`, { data: { op: { op: 'delete_rule', rule: 'FinalBonus' } } })).status()).toBe(401);
    // A valid token does not help a request that names a foreign Host or Origin.
    const foreignHost = await client.get(`${editor.origin}/api/model?token=${editor.token}`, { headers: { Host: 'attacker.example' } });
    expect(foreignHost.ok()).toBe(false);
    const foreignOrigin = await client.post(`${editor.origin}/api/apply?token=${editor.token}`, {
      headers: { Origin: 'http://attacker.example' },
      data: { op: { op: 'delete_rule', rule: 'FinalBonus' } },
    });
    expect(foreignOrigin.ok()).toBe(false);
    // The token itself works, so the refusals above are about the token and the origin.
    expect((await client.get(`${editor.origin}/api/model?token=${editor.token}`)).status()).toBe(200);
  } finally {
    await client.dispose();
  }
  expect(editor.read()).toBe(before);
  await expect(page.locator('#graph-root .graph-node')).toHaveCount(26);
});
