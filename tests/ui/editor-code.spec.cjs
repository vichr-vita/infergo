// The code pane and the file watcher: typing a parameter adds a wire, a
// buffer that does not parse writes nothing, and a save from outside updates
// the graph within a quarter of a second.
const { writeFileSync } = require('node:fs');
const { cpus, loadavg } = require('node:os');
const { test, expect, changedLines, fit, selectRule, receipt, typeInDeclaration } = require('./editor-fixture.cjs');

test.describe.configure({ timeout: 60_000 });

const wireKey = 'FinanceRequired>financeRequired>ReviewRequired';

test('item 5: typing a parameter in the code pane adds the wire in the graph', async ({ app: page, editor }) => {
  const before = editor.read();
  await fit(page);
  await selectRule(page, 'ReviewRequired');
  await expect(page.locator('#code-root .code-edit .cm-content')).toContainText('func ReviewRequired(');
  await expect(page.locator('#graph-root .graph-wire[data-wire="' + wireKey + '"]')).toHaveCount(0);

  await typeInDeclaration(page, before, 'ReviewRequired', 'func ReviewRequired(cappedBonusCents uint64, approvalsSatisfied bool', ', financeRequired bool');

  // Saved after a pause in typing, then drawn.
  await receipt(page, 'Edited the code of ReviewRequired');
  await expect(page.locator('#code-root .code-status')).toHaveText('Saved');
  await expect(page.locator('#graph-root .graph-wire[data-wire="' + wireKey + '"]')).toHaveCount(1);
  await expect(page.locator('#graph-root [data-rule="ReviewRequired"]')).toHaveAttribute('aria-label', /financeRequired bool\. Produces/);
  const changes = changedLines(before, editor.read());
  expect(changes).toHaveLength(1);
  expect(changes[0].after).toBe('func ReviewRequired(cappedBonusCents uint64, approvalsSatisfied bool, financeRequired bool) (reviewRequired *string) {');
  expect(editor.gofmtList('bonus.go')).toBe('');
});

test('item 5: a buffer that does not parse writes nothing and keeps the last graph', async ({ app: page, editor }) => {
  const before = editor.read();
  await fit(page);
  await selectRule(page, 'ReviewRequired');
  // A name with no type among typed parameters is a syntax error.
  await typeInDeclaration(page, before, 'ReviewRequired', 'func ReviewRequired(cappedBonusCents uint64, approvalsSatisfied bool', ', financeRequired');
  await expect(page.locator('#code-root .code-status')).toContainText('Syntax error');
  await expect(page.locator('#status')).toContainText('does not parse');
  await expect(page.locator('#code-root .code-edit .cm-mark-syntax')).toHaveCount(1);
  expect(editor.read()).toBe(before);
  await expect(page.locator('#graph-root [data-rule="ReviewRequired"]')).toHaveAttribute('aria-label', /Reads cappedBonusCents uint64; approvalsSatisfied bool\. Produces/);

  // Finishing the declaration writes it.
  await page.keyboard.type(' bool');
  await expect(page.locator('#code-root .code-status')).toHaveText('Saved');
  await receipt(page, 'Edited the code of ReviewRequired');
  expect(editor.read()).toContain('approvalsSatisfied bool, financeRequired bool)');
});

// The design asks for the graph to follow an outside save within 250 ms. Tests
// run on several workers at once, and every worker's editor also type-checks a
// package, so one sample can be late through scheduler noise alone. This test
// waits for each compiler run to finish before it saves again, takes five saves
// that alternate the two ways editors write files, and requires the median to
// meet 250 ms and none to exceed one second. On an idle machine every sample is
// near 120 ms. The measurement is wall-clock time, so a host that is already
// busy delays it for reasons that have nothing to do with the editor. When the
// one-minute load average exceeds the number of cores, the bounds grow by that
// ratio, and the log line says so.
test('item 5: saving the file from outside updates the graph within 250 ms', async ({ app: page, editor }) => {
  await fit(page);
  const base = editor.read();
  const withWire = base.replace('func ReviewRequired(cappedBonusCents uint64, approvalsSatisfied bool)', 'func ReviewRequired(cappedBonusCents uint64, approvalsSatisfied bool, financeRequired bool)');
  expect(withWire).not.toBe(base);
  // Resolves with the wall-clock time of the first DOM change that adds or removes the wire.
  const watch = () => page.evaluate(wire => new Promise(done => {
    const present = () => !!document.querySelector(`#graph-root .graph-wire[data-wire="${wire}"]`);
    const initial = present();
    const observer = new MutationObserver(() => {
      if (present() !== initial) { observer.disconnect(); done(Date.now()); }
    });
    observer.observe(document.querySelector('#graph-root'), { subtree: true, childList: true, attributes: true });
    window.__watching = (window.__watching ?? 0) + 1;
  }), wireKey);

  // Let the first compiler run finish, so it does not compete with the first sample.
  const idle = () => expect(page.locator('#summary')).not.toContainText('Checking');
  await idle();
  const samples = [];
  for (let round = 0; round < 5; round++) {
    const target = round % 2 === 0 ? withWire : base;
    const seen = watch();
    await page.waitForFunction(count => window.__watching === count, round + 1);
    const start = Date.now();
    // Rounds 0, 1, and 4 save the way most IDEs do, a new file renamed over the old one. Rounds 2 and 3 write in place.
    if (round % 4 < 2) editor.writeOutside('bonus.go', target);
    else writeFileSync(editor.path('bonus.go'), target);
    samples.push((await seen) - start);
    // A page that has drawn a new model is waiting for the compiler ("Checking"). Wait it out before the next save.
    await idle();
  }
  const slack = Math.max(1, loadavg()[0] / cpus().length);
  console.log(`outside saves: graph changed after ${samples.join(', ')} ms (bound scale ${slack.toFixed(1)})`);
  const median = [...samples].sort((a, b) => a - b)[2];
  expect(median).toBeLessThan(250 * slack);
  expect(Math.max(...samples)).toBeLessThan(1000 * slack);
});
