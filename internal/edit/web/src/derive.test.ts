import assert from 'node:assert/strict';
import test from 'node:test';
import { addRuleOp, deriveGraph, verdict, verdictMessage, verdicts, wirePath } from './derive';
import { fixtures } from './fixtures.check';
import type { Model } from './protocol';

const graph = deriveGraph(fixtures.model);

test('derives rules, facts, and wires from the bonus model', () => {
  assert.equal(graph.rules.size, 26);
  assert.equal([...graph.facts.values()].filter(fact => fact.input).length, 14);
  assert.equal([...graph.facts.values()].filter(fact => fact.requested).length, 5);
  assert.deepEqual(graph.producers.get('cappedBonusCents'), ['CappedBonus']);
  assert.deepEqual(graph.readers.get('cappedBonusCents'), ['FinanceRequired', 'FinalBonus', 'ReviewRequired']);
  assert.ok(graph.wires.some(wire => wire.from === 'CappedBonus' && wire.to === 'FinalBonus' && wire.fact === 'cappedBonusCents'));
  // Inputs make no wires: every wire starts at a rule.
  assert.ok(graph.wires.every(wire => graph.rules.has(wire.from)));
});

test('orders every rule after the rules it reads from', () => {
  const position = new Map(graph.order.map((id, index) => [id, index]));
  assert.equal(graph.order.length, 26);
  for (const wire of graph.wires) assert.ok(position.get(wire.from)! < position.get(wire.to)!, `${wire.from} before ${wire.to}`);
});

test('gives each verdict reason for the cases in the mockups', () => {
  assert.deepEqual(verdict(graph, 'financeRequired', 'ReviewRequired'), { ok: true });
  assert.deepEqual(verdict(graph, 'cappedBonusCents', 'ReviewRequired'), { ok: false, reason: 'reads' });
  assert.deepEqual(verdict(graph, 'finalBonusCents', 'FinalBonus'), { ok: false, reason: 'produces' });
  const cycle = verdict(graph, 'approvalsSatisfied', 'CappedBonus');
  assert.ok(!cycle.ok && cycle.reason === 'cycle');
  assert.deepEqual(cycle.path, ['CappedBonus', 'FinanceRequired', 'ApprovalsSatisfied']);
  assert.deepEqual(cycle.wires.map(wire => wire.fact), ['cappedBonusCents', 'financeRequired']);
  assert.equal(verdictMessage(cycle, 'approvalsSatisfied', 'CappedBonus'), 'It would create a cycle through FinanceRequired and ApprovalsSatisfied');
});

test('refuses every target for an unsupported rule', () => {
  const model: Model = structuredClone(fixtures.model);
  model.rules[0]!.unsupported = 'every result needs a name';
  const result = verdict(deriveGraph(model), 'salaryCents', model.rules[0]!.id);
  assert.deepEqual(result, { ok: false, reason: 'unsupported' });
  assert.equal(verdictMessage(result, 'salaryCents', model.rules[0]!.id, deriveGraph(model)), 'every result needs a name');
});

test('an input can go anywhere it is not already read', () => {
  const all = verdicts(graph, 'salaryCents');
  assert.equal(all.size, 26);
  const refused = [...all].filter(([, result]) => !result.ok).map(([id]) => id);
  assert.deepEqual(refused, graph.readers.get('salaryCents'));
});

test('a cyclic model still derives, with each rule on the cycle its own ancestor', () => {
  const model: Model = structuredClone(fixtures.model);
  model.rules.find(rule => rule.id === 'CappedBonus')!.reads.push({ name: 'finalBonusCents', type: 'uint64' });
  const cyclic = deriveGraph(model);
  assert.equal(cyclic.order.length, 26);
  assert.ok(cyclic.ancestors.get('CappedBonus')!.has('CappedBonus'));
  assert.ok(cyclic.ancestors.get('FinalBonus')!.has('FinalBonus'));
  assert.ok(!cyclic.ancestors.get('TenureAward')!.has('TenureAward'));
  assert.deepEqual(wirePath(cyclic, 'CappedBonus', 'FinalBonus')?.map(wire => wire.to), ['FinalBonus']);
});

test('a new rule from a dropped fact goes after its producer', () => {
  const read = { name: 'cappedBonusCents', type: 'uint64' };
  assert.deepEqual(addRuleOp(graph, 'LoyaltyTopUp', [{ name: 'loyaltyTopUpCents', type: 'uint64' }], read), {
    op: 'add_rule', name: 'LoyaltyTopUp', reads: [read], produces: [{ name: 'loyaltyTopUpCents', type: 'uint64' }], after: 'CappedBonus',
  });
});
