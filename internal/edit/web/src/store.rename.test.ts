import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveGraph, renamedRule } from './derive';
import { fixtures } from './fixtures.check';
import { mockApi } from './mock';
import { Store, type State } from './store';

async function until(store: Store, predicate: (state: State) => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate(store.state)) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the store');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('renamedRule finds the new id at the same place', () => {
  const before = deriveGraph(fixtures.model);
  const model = structuredClone(fixtures.model);
  model.rules.find(rule => rule.id === 'FinalBonus')!.id = 'ReleasedBonus';
  const after = deriveGraph(model);
  assert.equal(renamedRule(before, after, 'FinalBonus'), 'ReleasedBonus');
  assert.equal(renamedRule(before, after, 'CappedBonus'), 'CappedBonus');
  model.rules = model.rules.filter(rule => rule.id !== 'ReleasedBonus');
  assert.equal(renamedRule(before, deriveGraph(model), 'FinalBonus'), undefined);
});

test('a renamed rule stays selected through rename, undo, and redo', async () => {
  const connected = await Store.connect(mockApi({ latency: { request: 0, check: 0, values: 0 } }));
  assert.ok(connected.kind === 'ok');
  const store = connected.value;
  await until(store, state => state.connection === 'open');
  store.select({ rule: 'CappedBonus' });
  const result = await store.apply({ op: 'rename_rule', rule: 'CappedBonus', to: 'LimitedBonus' });
  assert.equal(result.kind, 'ok');
  await until(store, state => state.graph.rules.has('LimitedBonus'));
  assert.equal(store.state.selection.rule, 'LimitedBonus');
  await store.undo();
  await until(store, state => state.graph.rules.has('CappedBonus'));
  assert.equal(store.state.selection.rule, 'CappedBonus');
  await store.redo();
  await until(store, state => state.graph.rules.has('LimitedBonus'));
  assert.equal(store.state.selection.rule, 'LimitedBonus');
  store.dispose();
});
