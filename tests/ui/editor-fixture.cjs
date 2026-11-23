// Shared fixture for the editor browser tests. Each test gets its own copy of
// the bonus ruleset in a throwaway module and its own `infergen edit` process,
// so tests run in parallel and never touch ruleset/bonus.
const { spawn, execFileSync } = require('node:child_process');
const { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { test: base, expect: baseExpect } = require('@playwright/test');

// Each editor test waits on a real compiler run, and several run at once, so a
// verdict can take longer than the 5 s default.
const expect = baseExpect.configure({ timeout: 15_000 });

const { binaryPath, repoRoot, workRoot } = require('./editor-binary.cjs');

/** Copies the bonus ruleset into a fresh module that builds against this checkout. */
function copyRuleset() {
  mkdirSync(workRoot, { recursive: true });
  const dir = mkdtempSync(join(workRoot, 'run-'));
  for (const name of ['bonus.go', 'facts.go', 'zz_infergo_gen.go']) cpSync(join(repoRoot, 'ruleset/bonus', name), join(dir, name));
  const facts = join(dir, 'facts.go');
  writeFileSync(facts, readFileSync(facts, 'utf8').replace('go run ../../cmd/infergen', 'go run github.com/vichr-vita/infergo/cmd/infergen'));
  writeFileSync(join(dir, 'go.mod'), [
    'module example.com/bonus', '', 'go 1.26.0', '',
    'require github.com/vichr-vita/infergo v0.0.0', '',
    `replace github.com/vichr-vita/infergo => ${process.env.INFERGO_ROOT || repoRoot}`, '',
  ].join('\n'));
  cpSync(join(repoRoot, 'go.sum'), join(dir, 'go.sum'));
  return dir;
}

/** Starts infergen edit in dir and resolves with the URL it printed. */
function startServer(dir) {
  const child = spawn(binaryPath(), ['edit', '--rules', 'bonus.go', '--inputs', 'Inputs', '--outputs', 'Outputs', '--port', '0'], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(done => child.once('exit', code => done(code)));
  const url = new Promise((ok, fail) => {
    let out = '';
    child.stdout.on('data', chunk => {
      out += chunk;
      const match = out.match(/^(http:\/\/127\.0\.0\.1:\d+\/\S*)$/m);
      if (match) ok(match[1]);
    });
    child.once('error', fail);
    exited.then(code => fail(new Error(`infergen edit exited with ${code} before printing a URL:\n${stderr}`)));
  });
  return { child, url, exited, stderr: () => stderr };
}

/** One running editor: the ruleset copy, the server, and helpers over the files. */
class Editor {
  constructor(dir, server, url) {
    this.dir = dir;
    this.server = server;
    this.url = url;
    this.origin = new URL(url).origin;
    this.token = new URL(url).searchParams.get('token');
  }

  path(name) { return join(this.dir, name); }
  read(name = 'bonus.go') { return readFileSync(this.path(name), 'utf8'); }

  /** Writes a file the way an IDE does: temp file in the directory, then rename. */
  writeOutside(name, content) {
    const target = this.path(name);
    const temp = `${target}.ide-tmp`;
    writeFileSync(temp, content);
    renameSync(temp, target);
  }

  /** Replaces text in a file from outside the editor and returns the new content. */
  editOutside(name, from, to) {
    const before = this.read(name);
    if (!before.includes(from)) throw new Error(`${name} does not contain ${JSON.stringify(from)}`);
    const after = before.replace(from, () => to);
    this.writeOutside(name, after);
    return after;
  }

  /** Runs a command in the ruleset copy and returns its combined output, or throws. */
  run(command, args) {
    return execFileSync(command, args, { cwd: this.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  gofmtList(...names) { return this.run('gofmt', ['-l', ...names]).trim(); }

  /** Interrupts the server, waits for it to exit, removes the copy, and returns the exit code (null if it had to be killed). */
  async stop() {
    if (this.server.child.exitCode === null) this.server.child.kill('SIGINT');
    const timeout = new Promise(done => setTimeout(() => done('timeout'), 10000));
    let code = await Promise.race([this.server.exited, timeout]);
    if (code === 'timeout') { this.server.child.kill('SIGKILL'); code = null; }
    rmSync(this.dir, { recursive: true, force: true });
    return code;
  }
}

/** Starts an editor on a fresh copy. Used by the fixture and by tests that restart one. */
async function startEditor() {
  const dir = copyRuleset();
  const server = startServer(dir);
  try {
    const url = await server.url;
    return new Editor(dir, server, url);
  } catch (error) {
    server.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Waits until the first model has loaded, in the canvas layout or the list layout. */
async function ready(page) {
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#summary')).toContainText('26 rules');
}

/** Splits source into lines for comparisons that count changed lines. */
const linesOf = text => text.split('\n');

/** Number of lines that differ between two texts with the same number of lines. */
function changedLines(before, after) {
  const a = linesOf(before), b = linesOf(after);
  expect(b).toHaveLength(a.length);
  return a.flatMap((line, index) => (line === b[index] ? [] : [{ line: index + 1, before: line, after: b[index] }]));
}

/** Comment lines of a Go file: whole-line comments and trailing comments. */
const commentLines = text => linesOf(text).filter(line => line.includes('//'));

/** Zooms the graph out so every rule is on screen. */
async function fit(page) {
  await page.getByRole('button', { name: 'Fit map' }).click();
}

/** The Facts column row for a fact. A fact that is also an output appears in Outputs first. */
function factRow(page, name) {
  return page.locator(`#facts-root .fact-row[aria-label^="${name} "]`).first();
}

/** Presses on a source element and drags a little, so the fact is carried. Leaves the button down. */
async function pickUp(page, source) {
  await source.scrollIntoViewIfNeeded();
  const box = await source.boundingBox();
  const x = box.x + Math.min(20, box.width / 2), y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y + 10, { steps: 4 });
}

/** Moves the carried fact to the middle of an element, in steps. */
async function moveOver(page, target) {
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 });
}

/** Moves the carried fact to a point on the graph canvas that no node covers. */
async function moveOverEmptyCanvas(page) {
  const box = await page.locator('#graph-root .graph-viewport').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 40, { steps: 15 });
}

/** The graph node box for a rule, for pointer work. */
const nodeBox = (page, rule) => page.locator(`#graph-root [data-rule="${rule}"] .box`);

/**
 * Clicks a rule's name on the canvas. The click is forced because the name's
 * text and the node's box overlap and browsers disagree about which of them
 * Playwright's actionability check sees on top. The pointer event lands inside
 * the same node either way.
 */
const clickRuleName = (page, rule) => page.locator(`#graph-root [data-rule="${rule}"] .name`).click({ force: true });

/** Selects a rule by clicking its name on the canvas, after fitting the map so it is on screen. */
async function selectRule(page, rule) {
  await fit(page);
  await clickRuleName(page, rule);
  await expect(page.locator('#sheet-root .sheet-name')).toHaveText(`${rule}()`);
}

/**
 * Selects a rule and shows it at Actual size, centred, the way a person reads one in detail.
 * Below a zoom of 0.75 nodes draw only their names, so fact rows, fix links, and most wire labels
 * are hidden there. The rule is selected on the zoomed-out map, where every node is in reach,
 * then Actual size centres the view on it.
 */
async function showRule(page, rule) {
  await selectRule(page, rule);
  const actual = page.getByRole('button', { name: 'Actual size' });
  await actual.click();
  await expect(actual).toHaveAttribute('aria-pressed', 'true');
}

/** Drags a fact from the Facts column onto a rule and releases it. */
async function dragFactOntoRule(page, fact, rule) {
  await pickUp(page, factRow(page, fact));
  await moveOver(page, nodeBox(page, rule));
  await expect(page.locator('#status')).toContainText(`Drop to add ${fact}`);
  await page.mouse.up();
}

/** Waits for a receipt in the status line. */
const receipt = (page, text) => expect(page.locator('#status')).toContainText(text);

/** Types into the code pane after moving the caret by arrow keys, as a person would. */
async function typeInDeclaration(page, source, rule, after, text) {
  const start = source.indexOf(`// ${rule} `);
  const offset = source.indexOf(after, start) + after.length - start;
  await page.locator('#code-root .code-edit .cm-content').click();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < offset; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.type(text);
}

/** Asserts nothing is wider than the viewport. */
async function expectFits(page) {
  const found = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('body *')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width && (r.right > width + 1 || r.left < -1); })
      .map(el => `${el.tagName}.${el.getAttribute('class') ?? ''}#${el.id}`);
    return { scroll: document.documentElement.scrollWidth, width, wide };
  });
  expect(found.wide).toEqual([]);
  expect(found.scroll).toBeLessThanOrEqual(found.width);
}

const test = base.extend({
  // The running editor for this test. Torn down even when the test fails.
  editor: async ({}, use) => {
    const editor = await startEditor();
    try { await use(editor); } finally {
      // Ctrl+C is the documented way to stop the editor, and it must exit cleanly.
      expect(await editor.stop()).toBe(0);
    }
  },
  // A page already open on the editor's URL with the token.
  app: async ({ page, editor }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(editor.url);
    await ready(page);
    await use(page);
    expect(errors).toEqual([]);
  },
});

module.exports = {
  test, expect, startEditor, repoRoot, workRoot, changedLines, commentLines, fit, factRow, pickUp, moveOver,
  moveOverEmptyCanvas, nodeBox, clickRuleName, selectRule, showRule, dragFactOntoRule, receipt, typeInDeclaration, expectFits,
};
