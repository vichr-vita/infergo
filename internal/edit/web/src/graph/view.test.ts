import assert from 'node:assert/strict';
import test from 'node:test';
import { compactZoom, edgePan, edgePanning, edgeSpeed, fitTransform, isCompact, openingView, revealShift } from './view';

const size = { width: 700, height: 600 };
const node = { x: 100, y: 100, width: 280, height: 150 };

test('a rule already fully in view is not moved', () => {
  assert.deepEqual(revealShift(node, { x: 0, y: 0, k: 1 }, size), { dx: 0, dy: 0 });
  // Touching the edge still counts as visible: no nudge to the margin.
  assert.deepEqual(revealShift({ ...node, x: 0, y: 0 }, { x: 0, y: 0, k: 1 }, size), { dx: 0, dy: 0 });
});

test('a rule out of view moves the smallest distance, to the margin', () => {
  // 312 px above the top: comes down to 24 px from it, x untouched.
  assert.deepEqual(revealShift({ ...node, y: -312 }, { x: 0, y: 0, k: 1 }, size), { dx: 0, dy: 336 });
  // Cut by the right edge: moves left until its right side is 24 px in.
  assert.deepEqual(revealShift({ ...node, x: 500 }, { x: 0, y: 0, k: 1 }, size), { dx: -104, dy: 0 });
  // Below the bottom, at half zoom: the screen box is what counts.
  assert.deepEqual(revealShift({ ...node, y: 1400 }, { x: 0, y: 0, k: 0.5 }, size), { dx: 0, dy: -199 });
});

test('a rule larger than the viewport is centred across and shows its top', () => {
  const large = { x: 0, y: 900, width: 800, height: 800 };
  assert.deepEqual(revealShift(large, { x: 0, y: 0, k: 1 }, size), { dx: -50, dy: -876 });
});

test('edge speed grows with the square of depth in the band and is full at and past the edge', () => {
  const { band, maxSpeed, overshoot } = edgePanning;
  assert.equal(edgeSpeed(300, 600), 0);
  assert.equal(edgeSpeed(band, 600), 0);
  assert.equal(edgeSpeed(band / 2, 600), maxSpeed / 4);
  assert.equal(edgeSpeed(0, 600), maxSpeed);
  assert.equal(edgeSpeed(-overshoot, 600), maxSpeed);
  // Far past the edge the pointer has gone to another region.
  assert.equal(edgeSpeed(-overshoot - 1, 600), 0);
  // The bottom edge pans the other way.
  assert.equal(edgeSpeed(600 - band / 2, 600), -maxSpeed / 4);
});

test('edge pan stops once the graph edge is in view, and off the canvas', () => {
  const graph = { x: -400, y: -2000, width: 1200, height: 3000 };
  // Pointer at the top edge, a sixtieth of a second: the graph moves down.
  const top = edgePan({ x: 350, y: 0 }, size, graph, 1 / 60);
  assert.equal(top.dx, 0);
  assert.equal(top.dy, edgePanning.maxSpeed / 60);
  // The graph's top is already 24 px in: nothing left to reveal above.
  assert.deepEqual(edgePan({ x: 350, y: 0 }, size, { ...graph, y: 24 }, 1 / 60), { dx: 0, dy: 0 });
  // Only up to the margin.
  assert.equal(edgePan({ x: 350, y: 0 }, size, { ...graph, y: 20 }, 1 / 60).dy, 4);
  // Over the Facts column, far left of the canvas, nothing pans.
  assert.deepEqual(edgePan({ x: -150, y: 0 }, size, graph, 1 / 60), { dx: 0, dy: 0 });
  // In the middle, nothing pans.
  assert.deepEqual(edgePan({ x: 350, y: 300 }, size, graph, 1 / 60), { dx: 0, dy: 0 });
});

test('nodes go compact where 12 px rows would fall under 9 px', () => {
  assert.equal(compactZoom, 0.75);
  assert.equal(isCompact(0.75), false);
  assert.equal(isCompact(0.749), true);
  assert.equal(isCompact(0.2), true);
  assert.equal(isCompact(1), false);
});

test('the opening view fits the neighbourhood, centred on the rule, between the floor and Actual size', () => {
  const focus = { x: 400, y: 1000, width: 280, height: 150 };
  const near = [{ x: 400, y: 800, width: 280, height: 140 }, { x: 250, y: 1200, width: 280, height: 140 }];
  // Small neighbourhood: Actual size.
  const roomy = openingView(focus, near, { width: 1200, height: 1000 });
  assert.equal(roomy.k, 1);
  assert.equal(roomy.x, 600 - 540);
  assert.equal(roomy.y, 500 - 1075);
  // Fits only below Actual size.
  const tight = openingView(focus, near, { width: 1200, height: 500 });
  assert.equal(tight.k, (250 - 24) / 275);
  // Needs less than the floor: held at the floor, still centred on the rule.
  const far = openingView(focus, [{ x: 400, y: -200, width: 280, height: 140 }], size);
  assert.equal(far.k, compactZoom);
  assert.equal(far.x + 540 * far.k, 350);
  assert.equal(far.y + 1075 * far.k, 300);
});

test('fit centres the whole graph and never zooms past Actual size', () => {
  assert.deepEqual(fitTransform({ x: 0, y: 0, width: 200, height: 100 }, 700, 600), { x: 250, y: 250, k: 1 });
  const fitted = fitTransform({ x: 0, y: 0, width: 2000, height: 3000 }, 700, 600);
  assert.equal(fitted.k, 568 / 3000);
  assert.ok(Math.abs(fitted.y - 16) < 1e-9);
});
