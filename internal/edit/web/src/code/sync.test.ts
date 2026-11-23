import assert from 'node:assert/strict';
import test from 'node:test';
import { edited, isDirty, keepMine, loadDisk, loaded, replied, send, settle, wantsSend } from './sync';

const v1 = { id: 'A', source: '// A doc.\nfunc A(x int) (y int) {\n\treturn x\n}', sourceHash: 'h1' };
const typed = '// A doc.\nfunc A(x int, z int) (y int) {\n\treturn x\n}';

test('a clean buffer sends nothing; typing makes it dirty and sends with its base', () => {
  const sync = loaded(v1);
  assert.equal(wantsSend(sync, v1.source, 'idle'), false);
  assert.ok(isDirty(sync, typed));
  assert.ok(wantsSend(sync, typed, 'idle'));
  const { sync: sending, op } = send(sync, typed, false);
  assert.deepEqual(op, { op: 'replace_source', rule: 'A', text: typed, base: 'h1' });
  assert.equal(wantsSend(sending, typed + ' ', 'idle'), false, 'one write at a time');
});

test('an accepted write adopts the new hash and leaves an equal buffer alone', () => {
  let sync = send(loaded(v1), typed, false).sync;
  sync = replied(sync, { kind: 'ok', revision: 5 });
  // The reply came before its model: wait.
  assert.deepEqual(settle(sync, v1, typed, 4), { sync });
  const step = settle(sync, { source: typed, sourceHash: 'h2' }, typed, 5);
  assert.equal(step.load, undefined);
  assert.equal(step.sync.base, 'h2');
  assert.equal(isDirty(step.sync, typed), false);
  assert.equal(step.sync.formatted, false);
  assert.ok(wantsSend(step.sync, typed, 'leave'), 'leaving formats a raw write');
  assert.equal(wantsSend(step.sync, typed, 'idle'), false);
});

test('a formatted write loads what the server stored when the buffer still holds what was sent', () => {
  const messy = typed.replace('x int, z int', 'x  int,z int');
  let sync = replied(send(loaded(v1), messy, true).sync, { kind: 'ok', revision: 2 });
  const step = settle(sync, { source: typed, sourceHash: 'h2' }, messy, 2);
  assert.equal(step.load, typed);
  assert.equal(step.sync.formatted, true);
  // Typing since the send wins over the formatted text.
  sync = replied(send(loaded(v1), messy, true).sync, { kind: 'ok', revision: 2 });
  const later = settle(sync, { source: typed, sourceHash: 'h2' }, messy + '\n', 2);
  assert.equal(later.load, undefined);
  assert.ok(isDirty(later.sync, messy + '\n'));
});

test('a rename in the buffer moves the sync to the new rule id', () => {
  const renamed = typed.replace('func A(', 'func B(');
  const { sync, op } = send(loaded(v1), renamed, false);
  assert.equal(op.op === 'replace_source' && op.rule, 'A');
  assert.equal(replied(sync, { kind: 'ok', revision: 2 }).rule, 'B');
});

test('a syntax refusal names the line and blocks the same text until it changes', () => {
  const broken = typed.replace('(y int)', '(y int');
  const sync = replied(send(loaded(v1), broken, false).sync, { kind: 'refused', refusal: { reason: 'syntax_error', message: 'Line 2, column 30 of A does not parse: expected ).' } });
  assert.deepEqual(sync.problem, { kind: 'syntax', line: 2, message: 'Line 2, column 30 of A does not parse: expected ).', text: broken });
  assert.equal(wantsSend(sync, broken, 'idle'), false);
  assert.equal(wantsSend(sync, broken, 'leave'), false);
  const fixed = edited(sync, typed);
  assert.equal(fixed.problem, undefined);
  assert.ok(wantsSend(fixed, typed, 'idle'));
});

test('a failed request retries on save only', () => {
  const sync = replied(send(loaded(v1), typed, false).sync, { kind: 'failed', error: 'Server unreachable' });
  assert.equal(wantsSend(sync, typed, 'idle'), false);
  assert.ok(wantsSend(sync, typed, 'save'));
});

test('a clean buffer follows the disk; a dirty one gets the stale choices', () => {
  const disk = { source: v1.source.replace('return x', 'return x + 1'), sourceHash: 'h9' };
  const clean = settle(loaded(v1), disk, v1.source, 3);
  assert.equal(clean.load, disk.source);
  assert.equal(clean.sync.base, 'h9');

  const stale = settle(loaded(v1), disk, typed, 3);
  assert.equal(stale.load, undefined);
  assert.deepEqual(stale.sync.problem, { kind: 'stale', hash: 'h9', source: disk.source });
  assert.equal(wantsSend(stale.sync, typed, 'save'), false);

  const load = loadDisk(stale.sync);
  assert.equal(load.load, disk.source);
  assert.equal(load.sync.base, 'h9');
  assert.equal(load.sync.problem, undefined);

  const keep = keepMine(stale.sync);
  assert.equal(keep.base, 'h9');
  assert.ok(wantsSend(keep, typed, 'idle'));
  assert.equal(send(keep, typed, false).op.op === 'replace_source' && (send(keep, typed, false).op as { base: string }).base, 'h9');
});

test('a stale_base refusal waits for the model and then offers the choices', () => {
  let sync = replied(send(loaded(v1), typed, false).sync, { kind: 'refused', refusal: { reason: 'stale_base', message: 'A changed' } });
  assert.equal(sync.problem, undefined);
  sync = settle(sync, { source: 'other', sourceHash: 'h7' }, typed, 4).sync;
  assert.equal(sync.problem?.kind, 'stale');
});

test('disk catching up to the buffer clears the stale problem', () => {
  const stale = settle(loaded(v1), { source: 'x', sourceHash: 'h9' }, typed, 3).sync;
  const caught = settle(stale, { source: typed, sourceHash: 'h10' }, typed, 4);
  assert.equal(caught.sync.problem, undefined);
  assert.equal(isDirty(caught.sync, typed), false);
});
