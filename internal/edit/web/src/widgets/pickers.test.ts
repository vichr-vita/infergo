import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveGraph } from '../derive';
import { fixtures } from '../fixtures.check';
import { originText, readOptions, requestOptions } from './pickers';

const graph = deriveGraph(fixtures.model);

test('Add read keeps refused facts, disabled, with the reason', () => {
  const options = readOptions(graph, 'CappedBonus', '');
  const byFact = new Map(options.map(option => [option.fact, option]));
  assert.equal(byFact.get('eligibleBonusCents')?.reason, 'Already read');
  assert.equal(byFact.get('cappedBonusCents')?.reason, 'Produced by this rule');
  assert.equal(byFact.get('approvalsSatisfied')?.reason, 'Would create a cycle through FinanceRequired and ApprovalsSatisfied');
  assert.equal(byFact.get('salaryCents')?.reason, undefined);
  assert.equal(byFact.get('salaryCents')?.origin, 'Input');
  assert.equal(byFact.get('financeRequired')?.origin, '\u2190 FinanceRequired()');
  // Every fact with an origin is listed once.
  const known = [...graph.facts.values()].filter(info => info.input || info.producers.length).length;
  assert.equal(options.length, known);
});

test('Add read lists choosable facts first, prefix matches before others', () => {
  const options = readOptions(graph, 'CappedBonus', 'fin');
  const firstRefused = options.findIndex(option => option.reason);
  assert.ok(firstRefused > 0);
  assert.ok(options.slice(firstRefused).every(option => option.reason));
  assert.ok(options.every(option => option.fact.toLowerCase().includes('fin') || option.type.includes('fin')));
  const choosable = options.slice(0, firstRefused).map(option => option.fact);
  const prefixed = choosable.filter(name => name.toLowerCase().startsWith('fin'));
  assert.deepEqual(choosable.slice(0, prefixed.length), prefixed);
});

test('request options are derived facts not yet requested', () => {
  const options = requestOptions(graph, '');
  assert.ok(options.length > 0);
  for (const option of options) {
    const info = graph.facts.get(option.fact)!;
    assert.ok(info.producers.length && !info.requested, option.fact);
  }
  assert.equal(requestOptions(graph, 'zzz').length, 0);
});

test('origin of a dangling read', () => {
  assert.equal(originText(graph, 'nope'), 'No producer');
});
