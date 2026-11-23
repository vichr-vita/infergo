import assert from 'node:assert/strict';
import test from 'node:test';
import { diff, minimalEdits, previewMarks, type Edit } from './diff';

const signature = 'func ReviewRequired(cappedBonusCents uint64, approvalsSatisfied bool) (reviewRequired *string) {';
const wired = 'func ReviewRequired(cappedBonusCents uint64, approvalsSatisfied bool, financeRequired bool) (reviewRequired *string) {';

function apply(text: string, edits: Edit[]): string {
  let out = text;
  for (const edit of [...edits].reverse()) out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
  return out;
}

test('an added parameter is one inserted span holding exactly the parameter', () => {
  const parts = diff(signature, wired);
  assert.deepEqual(parts.filter(part => part.kind !== 'equal'), [{ kind: 'insert', text: ', financeRequired bool' }]);
  const marks = previewMarks(parts);
  assert.equal(marks.removed.length, 0);
  assert.equal(wired.slice(marks.inserted[0]!.from, marks.inserted[0]!.to), ', financeRequired bool');
});

test('a removed parameter is one removed span anchored where it was', () => {
  const marks = previewMarks(diff(wired, signature));
  assert.deepEqual(marks.inserted, []);
  assert.deepEqual(marks.removed, [{ at: signature.indexOf(') ('), text: ', financeRequired bool' }]);
});

test('a renamed identifier reads as the old word removed and the new one inserted', () => {
  const parts = diff('if bonusEligble {', 'if bonusEligible {');
  assert.deepEqual(parts, [
    { kind: 'equal', text: 'if ' },
    { kind: 'delete', text: 'bonusEligble' },
    { kind: 'insert', text: 'bonusEligible' },
    { kind: 'equal', text: ' {' },
  ]);
});

test('a blank alone between two changes joins them', () => {
  const parts = diff('a bool', 'b int');
  assert.deepEqual(parts.filter(part => part.kind !== 'equal').map(part => part.kind), ['delete', 'insert']);
});

test('changes across lines keep the untouched lines equal', () => {
  const before = '// Doc.\nfunc A(x int) (y int) {\n\treturn x\n}';
  const after = '// Doc.\nfunc A(x int) (y int) {\n\tif x > 0 {\n\t\treturn x\n\t}\n\treturn 0\n}';
  const parts = diff(before, after);
  assert.equal(parts[0]!.kind, 'equal');
  assert.ok(parts[0]!.text.startsWith('// Doc.\nfunc A(x int) (y int) {\n'));
  assert.equal(parts.map(part => (part.kind === 'delete' ? '' : part.text)).join(''), after);
  assert.equal(parts.map(part => (part.kind === 'insert' ? '' : part.text)).join(''), before);
});

test('minimal edits rebuild the new text and touch only what changed', () => {
  const edits = minimalEdits(signature, wired);
  assert.deepEqual(edits, [{ from: signature.indexOf(') ('), to: signature.indexOf(') ('), insert: ', financeRequired bool' }]);
  for (const [before, after] of [
    ['', 'func A() {}'], ['func A() {}', ''], ['abc def', 'abc xyz def'], ['x := 1\ny := 2', 'y := 2\nx := 1'], [wired, signature],
  ] as const) {
    assert.equal(apply(before, minimalEdits(before, after)), after);
  }
});

test('identical texts give no edits', () => {
  assert.deepEqual(minimalEdits(wired, wired), []);
  assert.deepEqual(diff(wired, wired), [{ kind: 'equal', text: wired }]);
});
