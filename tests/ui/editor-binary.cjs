// Where the infergen binary for the editor tests comes from. Global setup
// builds it once; INFERGEN_BIN points the tests at a prebuilt one instead,
// for hosts such as a Playwright container image that have no Go toolchain.
const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const repoRoot = resolve(__dirname, '../..');
const workRoot = join(repoRoot, '.edit-test');

/** Path of the infergen binary: INFERGEN_BIN, else the one global setup built. */
function binaryPath() {
  return process.env.INFERGEN_BIN || join(workRoot, 'infergen');
}

/** Builds the infergen binary once unless INFERGEN_BIN names a prebuilt one. */
function buildBinary() {
  if (process.env.INFERGEN_BIN) return;
  mkdirSync(workRoot, { recursive: true });
  execFileSync('go', ['build', '-o', join(workRoot, 'infergen'), './cmd/infergen'], { cwd: repoRoot, stdio: 'inherit' });
}

module.exports = { binaryPath, buildBinary, repoRoot, workRoot };
