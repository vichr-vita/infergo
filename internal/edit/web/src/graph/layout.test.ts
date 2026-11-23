import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveGraph, wireKey } from '../derive';
import { fixtures } from '../fixtures.check';
import type { Check, Model } from '../protocol';
import { anchorShift, box, buildLayoutInput, buildNode, compactLines, gatherFindings, noFindings, place, shifted, type Measure } from './layout';

// Seven units per character stands in for canvas measurement.
const measure: Measure = text => Array.from(text).length * 7;
const graph = deriveGraph(fixtures.model);

test('builds one node per rule and one label per wire', () => {
  const input = buildLayoutInput(graph, noFindings, measure);
  assert.equal(input.nodes.length, 26);
  assert.equal(input.labels.length, graph.wires.length);
  assert.deepEqual(input.labels.map(label => label.key), graph.wires.map(wireKey));
});

test('a node lists reads, name, requirement, and produces, top to bottom', () => {
  const node = buildNode(graph.rules.get('CappedBonus')!, graph, noFindings, measure);
  assert.deepEqual(node.reads.map(row => [row.fact, row.origin]), [['eligibleBonusCents', 'rule'], ['employeeBudgetCents', 'input']]);
  assert.deepEqual(node.produces.map(row => row.fact), ['cappedBonusCents']);
  assert.ok(node.reads[1]!.top < node.name.top);
  assert.ok(node.name.top < node.requirement.top);
  assert.ok(node.requirement.top < node.produces[0]!.top);
  assert.match(node.label, /^CappedBonus\. Reads eligibleBonusCents uint64; employeeBudgetCents uint64, an input\. Produces cappedBonusCents uint64\. No problems\.$/);
  // Every line is accounted for in the height.
  const requirementLines = node.requirement.lines.length;
  assert.equal(node.height, 12 + 2 * box.row + 8 + 22 + requirementLines * box.proseLine + 8 + box.row + 6);
});

test('a long name keeps its line and moves the type below it', () => {
  const rule = { ...graph.rules.get('CappedBonus')!, reads: [{ name: 'aVeryLongFactNameThatFillsTheRow', type: 'map[string]uint64' }] };
  const node = buildNode(rule, graph, noFindings, measure);
  assert.equal(node.reads[0]!.typeBelow, true);
  assert.deepEqual(node.reads[0]!.lines, ['aVeryLongFactNameThatFillsTheRow']);
  assert.equal(node.reads[0]!.height, 2 * box.row);
});

test('the aimed read adds a pending row without changing the layout input', () => {
  const rule = graph.rules.get('ReviewRequired')!;
  const plain = buildNode(rule, graph, noFindings, measure);
  const aimed = buildNode(rule, graph, noFindings, measure, undefined, { pending: { name: 'financeRequired', type: 'bool' } });
  assert.equal(aimed.reads.length, plain.reads.length + 1);
  assert.deepEqual(aimed.reads.at(-1)!.lines, ['+ financeRequired']);
  assert.equal(aimed.reads.at(-1)!.pending, true);
  assert.equal(aimed.height, plain.height + box.row);
  const first = buildLayoutInput(graph, noFindings, measure);
  const second = buildLayoutInput(graph, noFindings, measure);
  assert.equal(first.signature, second.signature);
});

test('diagnostics land on rows, wires, and nodes, and change the layout input', () => {
  const check: Check = {
    revision: 1, ok: false, pruned: ['RetentionAward'], evaluator: 'kept',
    diagnostics: [
      { severity: 'error', kind: 'type_mismatch', message: 'm', rule: 'FinanceRequired', fact: 'cappedBonusCents', related: ['CappedBonus'], fixes: [{ label: 'Use uint64 in FinanceRequired', op: { op: 'set_type', rule: 'FinanceRequired', fact: 'cappedBonusCents', type: 'uint64' } }] },
      { severity: 'error', kind: 'cycle', message: 'm', rule: 'CappedBonus', fact: 'financeRequired', related: ['CappedBonus', 'FinanceRequired'], fixes: [{ label: 'Remove cappedBonusCents from FinanceRequired', op: { op: 'remove_read', rule: 'FinanceRequired', fact: 'cappedBonusCents' } }] },
    ],
  };
  const model: Model = structuredClone(fixtures.model);
  model.rules.find(rule => rule.id === 'FinanceRequired')!.reads[0]!.type = 'uint32';
  const mismatched = deriveGraph(model);
  const findings = gatherFindings(mismatched, check.diagnostics, check.pruned);
  const reader = buildNode(mismatched.rules.get('FinanceRequired')!, mismatched, findings, measure);
  assert.equal(reader.reads[0]!.typeText, 'uint32 ≠ uint64');
  assert.equal(reader.reads[0]!.error, true);
  assert.deepEqual(reader.notes.map(note => note.lines.join(' ')), ['cappedBonusCents is uint64 from CappedBonus and uint32 here.']);
  assert.deepEqual(reader.notes[0]!.fixes.map(fix => fix.fix.label), ['Use uint64 in FinanceRequired']);
  assert.equal(reader.problems?.text, '2 errors'); // its mismatch, and its place on the cycle
  // The cycle's wire carries its own Remove this wire link; the node does not repeat it.
  const key = 'CappedBonus>cappedBonusCents>FinanceRequired';
  assert.ok(findings.cycleWires.has(key));
  const cycleNode = buildNode(mismatched.rules.get('CappedBonus')!, mismatched, findings, measure);
  assert.deepEqual(cycleNode.notes.flatMap(note => note.fixes), []);
  assert.equal(findings.pruned.has('RetentionAward'), true);
  const pruned = buildNode(mismatched.rules.get('RetentionAward')!, mismatched, findings, measure);
  assert.deepEqual(pruned.notes.map(note => note.lines.join(' ')), ['Not needed by any output.']);
  assert.notEqual(buildLayoutInput(mismatched, findings, measure).signature, buildLayoutInput(mismatched, noFindings, measure).signature);
});

test('a read with no producer is marked missing', () => {
  const model: Model = structuredClone(fixtures.model);
  model.rules.find(rule => rule.id === 'EligibleBonus')!.reads[0]!.name = 'bonusEligble';
  const broken = deriveGraph(model);
  const node = buildNode(broken.rules.get('EligibleBonus')!, broken, noFindings, measure);
  assert.equal(node.reads[0]!.origin, 'missing');
});

test('dagre places every rule, even on a cycle', () => {
  const model: Model = structuredClone(fixtures.model);
  model.rules.find(rule => rule.id === 'CappedBonus')!.reads.push({ name: 'approvalsSatisfied', type: 'bool' });
  const cyclic = deriveGraph(model);
  const placement = place(buildLayoutInput(cyclic, noFindings, measure));
  assert.equal(placement.nodes.size, 26);
  for (const rect of placement.nodes.values()) assert.ok(Number.isFinite(rect.x) && Number.isFinite(rect.y));
  assert.ok(placement.wires.get('ApprovalsSatisfied>approvalsSatisfied>CappedBonus')!.length >= 2);
  // Top to bottom: a producer sits above its reader outside the cycle.
  assert.ok(placement.nodes.get('FinalBonus')!.y < placement.nodes.get('PaymentReady')!.y);
});

test('the anchor rule keeps its corner after a new layout', () => {
  const before = place(buildLayoutInput(graph, noFindings, measure));
  const model: Model = structuredClone(fixtures.model);
  model.rules.push({ ...structuredClone(model.rules.find(rule => rule.id === 'FinanceRequired')!), id: 'Extra', produces: [{ name: 'extra', type: 'bool' }] });
  const next = place(buildLayoutInput(deriveGraph(model), noFindings, measure));
  const { dx, dy } = anchorShift(before, next, ['FinalBonus']);
  const moved = shifted(next, dx, dy);
  assert.deepEqual([moved.nodes.get('FinalBonus')!.x, moved.nodes.get('FinalBonus')!.y], [before.nodes.get('FinalBonus')!.x, before.nodes.get('FinalBonus')!.y]);
  // With no anchor in both, the origin stays where the earlier shifts left it.
  const again = anchorShift(moved, next, ['Missing']);
  assert.deepEqual(again, { dx: moved.bounds.x - next.bounds.x, dy: moved.bounds.y - next.bounds.y });
});

test('a compact name breaks between its words and ends in an ellipsis when it runs out of room', () => {
  const six = (text: string) => Array.from(text).length * 6;
  // Ten characters a line.
  assert.deepEqual(compactLines('CappedBonus()', 60, 2, six), ['Capped', 'Bonus()']);
  assert.deepEqual(compactLines('RoleRate()', 60, 1, six), ['RoleRate()']);
  // One line: as much of the name as fits, then the ellipsis.
  assert.deepEqual(compactLines('GoodPerformance()', 60, 1, six), ['GoodPerfo…']);
  // A word longer than a line is cut on its own line.
  assert.deepEqual(compactLines('ExceptionalPerformance()', 60, 2, six), ['Exception…', 'Performan…']);
  // More words than lines: the last line takes the rest.
  assert.deepEqual(compactLines('IsBonusEligible()', 42, 2, six), ['IsBonus', 'Eligib…']);
  // Never fewer than one line, and never more characters than fit.
  for (const line of compactLines('PaymentReference()', 30, 0, six)) assert.ok(six(line) <= 30);
});
