import assert from 'node:assert/strict';
import test from 'node:test';
import type { Receipt } from '../protocol';
import { clockTime, historyRows } from './steps';

const entry = (id: number, extra: Partial<Receipt> = {}): Receipt =>
  ({ id, label: `change ${id}`, source: 'editor', files: [{ path: 'bonus.go', added: 1, removed: 1 }], time: '2026-11-23T09:14:02Z', ...extra });

test('rows run newest first with undo and redo step counts', () => {
  const rows = historyRows({ entries: [entry(1), entry(2), entry(3), entry(4)], cursor: 3 });
  assert.deepEqual(rows.map(row => row.entry.id), [4, 3, 2, 1]);
  assert.deepEqual(rows.map(row => row.undone), [true, false, false, false]);
  assert.deepEqual(rows.map(row => row.current), [false, true, false, false]);
  assert.deepEqual(rows.map(row => row.action), [
    { direction: 'redo', steps: 1 },
    { direction: 'undo', steps: 1 },
    { direction: 'undo', steps: 2 },
    { direction: 'undo', steps: 3 },
  ]);
});

test('no action across an entry that can no longer be undone', () => {
  const rows = historyRows({ entries: [entry(1, { undoable: false }), entry(2, { source: 'disk' }), entry(3)], cursor: 3 });
  assert.equal(rows.find(row => row.entry.id === 1)?.action, undefined);
  assert.deepEqual(rows.find(row => row.entry.id === 2)?.action, { direction: 'undo', steps: 2 });
});

test('clock time falls back to the raw text', () => {
  assert.match(clockTime('2026-11-23T09:14:02Z'), /^\d\d:\d\d:02$/);
  assert.equal(clockTime('soon'), 'soon');
});
