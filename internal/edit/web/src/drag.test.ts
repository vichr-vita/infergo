import assert from 'node:assert/strict';
import test from 'node:test';
import { clickOutcome, dragThreshold, pastThreshold } from './drag';

test('a press becomes a drag only once it travels the threshold', () => {
  const start = { x: 100, y: 100 };
  assert.equal(dragThreshold, 4);
  assert.equal(pastThreshold(start, { x: 100, y: 100 }), false);
  assert.equal(pastThreshold(start, { x: 103, y: 100 }), false);
  assert.equal(pastThreshold(start, { x: 102, y: 102 }), false); // 2.83 px diagonally
  assert.equal(pastThreshold(start, { x: 104, y: 100 }), true);
  assert.equal(pastThreshold(start, { x: 97, y: 97 }), true); // 4.24 px
});

test('a click picks a fact up, and clicking the held fact again puts it down', () => {
  assert.equal(clickOutcome({ fact: 'a', clickHolds: true, heldByClick: false }), 'hold');
  assert.equal(clickOutcome({ fact: 'a', clickHolds: true, heldFact: 'a', heldByClick: true }), 'put-down');
  // Another fact replaces the one held.
  assert.equal(clickOutcome({ fact: 'b', clickHolds: true, heldFact: 'a', heldByClick: true }), 'hold');
  // Held by the keyboard, a click on the same fact picks it up for the pointer instead of dropping it.
  assert.equal(clickOutcome({ fact: 'a', clickHolds: true, heldFact: 'a', heldByClick: false }), 'hold');
  // A wire label's click selects the wire; only a drag picks its fact up.
  assert.equal(clickOutcome({ fact: 'a', clickHolds: false, heldByClick: false }), 'none');
});
