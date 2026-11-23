import assert from 'node:assert/strict';
import test from 'node:test';
import { declName, firstFileLine, placeDiagnostic, refusalLine, stubCaret } from './lines';
import type { Diagnostic } from '../protocol';

const source = [
  '// EligibleBonus allows a payment only for eligible',
  '// employees. BR-18.',
  'func EligibleBonus(bonusEligble bool, proposedBonusCents uint64) (eligibleBonusCents uint64) {',
  '\tif bonusEligble {',
  '\t\treturn proposedBonusCents',
  '\t}',
  '\treturn 0',
  '}',
].join('\n');

const diagnostic = (fields: Partial<Diagnostic>): Diagnostic => ({ severity: 'error', kind: 'go', message: 'm', fixes: [], ...fields });

test('the first line is the doc comment, counted back from the func line', () => {
  assert.equal(firstFileLine({ line: 149, source }), 147);
  assert.equal(firstFileLine({ line: 12, source: 'func A() {}' }), 12);
});

test('reads the function name the buffer declares', () => {
  assert.equal(declName(source), 'EligibleBonus');
  assert.equal(declName('// Doc.\nfunc  Renamed(x int) {}'), 'Renamed');
  assert.equal(declName('// only a comment'), undefined);
});

test('reads the line from both server and mock syntax refusals', () => {
  assert.equal(refusalLine('Line 4, column 3 of Single does not parse: expected operand.'), 4);
  assert.equal(refusalLine('line 2: the parameter list is not closed'), 2);
  assert.equal(refusalLine('Something else'), undefined);
});

test('puts a stub caret at the start of its body line', () => {
  const stub = '// New TODO: state the requirement.\nfunc New(a int) (b int, err error) {\n\treturn b, errors.New("New is not implemented")\n}';
  assert.equal(stub.slice(stubCaret(stub)).split('\n')[0], 'return b, errors.New("New is not implemented")');
});

test('underlines the fact a diagnostic names on its line', () => {
  const placed = placeDiagnostic(source, 147, diagnostic({ line: 149, column: 1, fact: 'bonusEligble', kind: 'missing_producer' }))!;
  assert.equal(placed.line, 3);
  assert.equal(source.slice(placed.from, placed.to), 'bonusEligble');
});

test('underlines the identifier at the column, else the line', () => {
  const at = placeDiagnostic(source, 147, diagnostic({ line: 151, column: 10 }))!;
  assert.equal(source.slice(at.from, at.to), 'proposedBonusCents');
  const line = placeDiagnostic(source, 147, diagnostic({ line: 153, column: 1 }))!;
  assert.equal(source.slice(line.from, line.to), 'return 0');
});

test('ignores a diagnostic outside the declaration or without a line', () => {
  assert.equal(placeDiagnostic(source, 147, diagnostic({ line: 146 })), undefined);
  assert.equal(placeDiagnostic(source, 147, diagnostic({ line: 155 })), undefined);
  assert.equal(placeDiagnostic(source, 147, diagnostic({})), undefined);
});
