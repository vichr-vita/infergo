// The two store behaviours the code pane relies on: beforeWrite holds a write
// until the pane has saved, and the selection follows a renamed rule.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mockApi } from '../mock';
import { Store, type PendingWrite } from '../store';

const instant = { latency: { request: 0, check: 0, values: 0 } };

async function connect() {
  const api = mockApi(instant);
  const result = await Store.connect(api);
  assert.ok(result.kind === 'ok');
  const store = result.value;
  const deadline = Date.now() + 1000;
  while (store.state.connection !== 'open') {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the store');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  return { api, store };
}

test('beforeWrite runs before each write is sent and holds it until it settles', async () => {
  const { api, store } = await connect();
  const seen: PendingWrite[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  store.beforeWrite(write => { seen.push(write); return write.action === 'apply' ? held : undefined; });
  const op = { op: 'add_read', rule: 'ReviewRequired', fact: 'financeRequired', type: 'bool' } as const;
  const applying = store.apply(op);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(seen, [{ action: 'apply', op }]);
  assert.ok(!api.current().rules.find(rule => rule.id === 'ReviewRequired')!.reads.some(read => read.name === 'financeRequired'), 'not sent yet');
  release();
  assert.equal((await applying).kind, 'ok');
  await store.undo();
  assert.deepEqual(seen.at(-1), { action: 'undo' });
  store.dispose();
});

test('the selection follows a rule renamed in its own source', async () => {
  const { store } = await connect();
  store.select({ rule: 'ReviewRequired' });
  const rule = store.state.graph.rules.get('ReviewRequired')!;
  const text = rule.source.replace('func ReviewRequired(', 'func NeedsReview(');
  assert.equal((await store.apply({ op: 'replace_source', rule: rule.id, text, base: rule.sourceHash })).kind, 'ok');
  assert.equal(store.state.selection.rule, 'NeedsReview');
  store.dispose();
});
