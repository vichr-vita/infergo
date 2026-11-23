import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveGraph } from '../derive';
import type { Model } from '../protocol';
import { neighbour, stepTarget, wiresAt } from './keys';
import type { Rect } from './layout';

// A diamond: Top feeds Left and Right, both feed Bottom. Far sits beside Right.
const rule = (id: string, reads: string[], produces: string[]) => ({
  id, file: 'x.go', line: 1, requirement: '', source: '', sourceHash: '', usesContext: false, returnsError: false, stub: false,
  reads: reads.map(name => ({ name, type: 'bool' })), produces: produces.map(name => ({ name, type: 'bool' })),
});
const model: Model = {
  revision: 1, package: 'x', files: [],
  inputs: { type: 'Inputs', file: 'x.go', editable: true, fields: [] },
  outputs: { type: 'Outputs', file: 'x.go', editable: true, fields: [] },
  rules: [rule('Top', [], ['t']), rule('Left', ['t'], ['l']), rule('Right', ['t'], ['r']), rule('Far', [], ['f']), rule('Bottom', ['l', 'r'], ['b'])],
};
const graph = deriveGraph(model);
const at = (x: number, y: number): Rect => ({ x, y, width: 100, height: 60 });
const nodes = new Map<string, Rect>([['Top', at(150, 0)], ['Left', at(0, 200)], ['Right', at(300, 200)], ['Far', at(600, 200)], ['Bottom', at(150, 400)]]);

test('Up goes to a producer and Down to a reader, nearest horizontally first', () => {
  assert.equal(neighbour(graph, nodes, 'Left', 'up'), 'Top');
  assert.equal(neighbour(graph, nodes, 'Top', 'down'), 'Left'); // Left and Right are equally near; source order breaks the tie
  assert.equal(neighbour(graph, nodes, 'Bottom', 'up'), 'Left');
  assert.equal(neighbour(graph, nodes, 'Right', 'down'), 'Bottom');
  assert.equal(neighbour(graph, nodes, 'Top', 'up'), undefined);
  assert.equal(neighbour(graph, nodes, 'Far', 'down'), undefined);
});

test('Left and Right stay in the rank', () => {
  assert.equal(neighbour(graph, nodes, 'Left', 'right'), 'Right');
  assert.equal(neighbour(graph, nodes, 'Right', 'right'), 'Far');
  assert.equal(neighbour(graph, nodes, 'Right', 'left'), 'Left');
  assert.equal(neighbour(graph, nodes, 'Left', 'left'), undefined);
  assert.equal(neighbour(graph, nodes, 'Top', 'right'), undefined);
});

test('a held fact steps through valid targets in reading order and wraps', () => {
  const targets = ['Bottom', 'Far', 'Left'];
  assert.equal(stepTarget(nodes, targets, undefined, 'down'), 'Left');
  assert.equal(stepTarget(nodes, targets, 'Left', 'down'), 'Far');
  assert.equal(stepTarget(nodes, targets, 'Far', 'right'), 'Bottom');
  assert.equal(stepTarget(nodes, targets, 'Bottom', 'down'), 'Left');
  assert.equal(stepTarget(nodes, targets, 'Left', 'up'), 'Bottom');
  // From a rule that is not a target: the next target after it, or the one before.
  assert.equal(stepTarget(nodes, targets, 'Right', 'down'), 'Far');
  assert.equal(stepTarget(nodes, targets, 'Right', 'up'), 'Left');
  assert.equal(stepTarget(nodes, [], 'Right', 'down'), undefined);
});

test('wires at a rule are ordered by where their labels sit', () => {
  const labels = new Map<string, Rect>([['Left>l>Bottom', at(400, 300)], ['Right>r>Bottom', at(100, 300)]]);
  assert.deepEqual(wiresAt(graph, labels, 'Bottom', 'in').map(wire => wire.from), ['Right', 'Left']);
  assert.deepEqual(wiresAt(graph, labels, 'Top', 'out').map(wire => wire.to), ['Left', 'Right']);
});
