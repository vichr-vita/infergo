import assert from 'node:assert/strict';
import test from 'node:test';
import { stepThrough } from './nav';

const order = ['A', 'B', 'C', 'D'];

test('plain steps stop at the ends', () => {
  assert.equal(stepThrough(order, 'B', 1), 'C');
  assert.equal(stepThrough(order, 'D', 1), 'D');
  assert.equal(stepThrough(order, 'A', -1), 'A');
  assert.equal(stepThrough(order, undefined, 1), 'A');
  assert.equal(stepThrough(order, undefined, -1), 'D');
});

test('while holding, steps skip rules that cannot take the fact', () => {
  const allowed = new Set(['A', 'D']);
  assert.equal(stepThrough(order, 'A', 1, allowed), 'D');
  assert.equal(stepThrough(order, 'B', 1, allowed), 'D');
  assert.equal(stepThrough(order, 'C', -1, allowed), 'A');
  assert.equal(stepThrough(order, 'B', 1, new Set()), undefined);
});
