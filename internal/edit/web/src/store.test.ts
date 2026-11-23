import assert from 'node:assert/strict';
import test from 'node:test';
import type { Api, Result } from './api';
import { fixtures } from './fixtures.check';
import { mockApi } from './mock';
import type { ApplyReply, PreviewReply } from './protocol';
import { canUndo, shownRule, Store, validTargets, type State } from './store';

const instant = { latency: { request: 0, check: 0, values: 0 } };

async function connect(api: Api): Promise<Store> {
  const result = await Store.connect(api);
  assert.ok(result.kind === 'ok', 'the mock model loads');
  const store = result.value;
  await until(store, state => state.connection === 'open' && !!state.check);
  return store;
}

// Waits for the store to reach a state, failing after a second.
async function until(store: Store, predicate: (state: State) => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate(store.state)) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the store');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('connects, selects the first output producer, and loads history and check', async () => {
  const store = await connect(mockApi(instant));
  assert.equal(store.state.model.rules.length, 26);
  assert.equal(store.state.selection.rule, 'FinalBonus');
  assert.equal(store.state.check?.ok, true);
  assert.deepEqual(store.state.history, { entries: [], cursor: 0 });
  store.dispose();
});

test('hold, aim, drop adds the read, and undo takes it back', async () => {
  const api = mockApi(instant);
  const store = await connect(api);
  store.hold('financeRequired');
  assert.equal(store.state.held?.fact.type, 'bool');
  assert.ok(validTargets(store.state).includes('ReviewRequired'));
  assert.ok(!validTargets(store.state).includes('FinanceRequired'));

  store.aim('ReviewRequired');
  assert.equal(store.state.preview?.state, 'loading');
  assert.equal(shownRule(store.state)?.id, 'ReviewRequired');
  await until(store, state => state.preview?.state === 'ready');
  const preview = store.state.preview;
  assert.ok(preview?.state === 'ready');
  assert.match(preview.changes[0]!.after, /approvalsSatisfied bool, financeRequired bool\)/);

  await store.drop();
  assert.equal(store.state.held, undefined);
  assert.equal(store.state.preview, undefined);
  assert.equal(store.state.selection.rule, 'ReviewRequired');
  await until(store, state => state.graph.readers.get('financeRequired')?.includes('ReviewRequired') ?? false);
  const notice = store.state.notice;
  assert.ok(notice?.kind === 'receipt' && notice.action === 'apply');
  assert.equal(notice.receipt.label, 'Wired financeRequired into ReviewRequired');
  assert.deepEqual(notice.receipt.files, [{ path: 'bonus.go', added: 1, removed: 1 }]);
  await until(store, state => state.history.cursor === 1);
  assert.ok(canUndo(store.state));

  await store.undo();
  await until(store, state => !state.graph.readers.get('financeRequired')?.includes('ReviewRequired'));
  assert.equal(store.state.notice?.kind === 'receipt' && store.state.notice.action, 'undo');
  assert.equal(api.current().rules.find(rule => rule.id === 'ReviewRequired')!.source, fixtures.model.rules.find(rule => rule.id === 'ReviewRequired')!.source);
  store.dispose();
});

test('aiming at a rule that would close a cycle shows the path and writes nothing', async () => {
  const api = mockApi(instant);
  const store = await connect(api);
  const revision = api.current().revision;
  store.hold('approvalsSatisfied');
  store.aim('CappedBonus');
  const verdict = store.state.held?.verdict;
  assert.ok(verdict && !verdict.ok && verdict.reason === 'cycle');
  assert.deepEqual(verdict.path, ['CappedBonus', 'FinanceRequired', 'ApprovalsSatisfied']);
  assert.equal(store.state.preview, undefined);
  await store.drop();
  assert.equal(store.state.held, undefined);
  const notice = store.state.notice;
  assert.ok(notice?.kind === 'refusal' && notice.refusal.reason === 'cycle');
  assert.equal(notice.refusal.message, 'No drop here. It would create a cycle through FinanceRequired and ApprovalsSatisfied.');
  assert.equal(api.current().revision, revision);
  store.dispose();
});

test('dropping on nothing cancels, and the mock refuses a cyclic add_read sent directly', async () => {
  const store = await connect(mockApi(instant));
  store.hold('salaryCents');
  await store.drop();
  assert.equal(store.state.held, undefined);
  const result = await store.apply({ op: 'add_read', rule: 'CappedBonus', fact: 'approvalsSatisfied', type: 'bool' });
  assert.ok(result.kind === 'refused' && result.refusal.reason === 'cycle');
  assert.ok(store.state.notice?.kind === 'refusal');
  store.dispose();
});

test('a late preview reply for an earlier aim is dropped', async () => {
  const base = mockApi(instant);
  const pending: { rule: string; resolve: () => void }[] = [];
  const api: Api = {
    ...base,
    preview(op) {
      return new Promise<Result<PreviewReply>>(resolve => {
        const rule = ('rule' in op ? op.rule : undefined) ?? '';
        pending.push({ rule, resolve: () => resolve({ kind: 'ok', value: { changes: [{ file: 'bonus.go', rule, before: '', after: op.op }] } }) });
      });
    },
  };
  const store = await connect(api);
  store.hold('financeRequired');
  store.aim('ReviewRequired');
  store.aim('FinalBonus');
  assert.deepEqual(pending.map(entry => entry.rule), ['ReviewRequired', 'FinalBonus']);
  pending[1]!.resolve();
  await until(store, state => state.preview?.state === 'ready');
  pending[0]!.resolve();
  await new Promise(resolve => setTimeout(resolve, 5));
  const preview = store.state.preview;
  assert.ok(preview?.state === 'ready');
  assert.equal(preview.changes[0]!.rule, 'FinalBonus');
  store.cancel();
  assert.equal(store.state.preview, undefined);
  store.dispose();
});

test('previewOp and clearPreview serve hover previews, and clearPreview ignores another op', async () => {
  const store = await connect(mockApi(instant));
  const remove = { op: 'remove_read', rule: 'FinalBonus', fact: 'cappedBonusCents' } as const;
  store.previewOp(remove);
  await until(store, state => state.preview?.state === 'ready');
  store.clearPreview({ op: 'remove_read', rule: 'FinalBonus', fact: 'approvalsSatisfied' });
  assert.equal(store.state.preview?.state, 'ready');
  store.clearPreview(remove);
  assert.equal(store.state.preview, undefined);
  store.dispose();
});

test('watch calls a listener only when its slices change', async () => {
  const store = await connect(mockApi(instant));
  const seen: (string | undefined)[] = [];
  store.watch(state => [state.selection.rule], ([rule]) => seen.push(rule));
  store.highlight('salaryCents');
  store.setQuery('bonus');
  store.select({ rule: 'CappedBonus' });
  store.select({ rule: 'CappedBonus' });
  assert.deepEqual(seen, ['FinalBonus', 'CappedBonus']);
  store.dispose();
});

test('a model event that removes the aimed rule clears the aim, and a renamed held fact is put down', async () => {
  const api = mockApi(instant);
  const store = await connect(api);
  store.hold('financeRequired');
  store.aim('ReviewRequired');
  await until(store, state => state.preview?.state === 'ready');
  const write: Result<ApplyReply> = await api.apply({ op: 'delete_rule', rule: 'ReviewRequired' });
  assert.equal(write.kind, 'ok');
  await until(store, state => !state.graph.rules.has('ReviewRequired'));
  assert.equal(store.state.held?.over, undefined);
  assert.equal(store.state.preview, undefined);
  await api.apply({ op: 'rename_fact', fact: 'financeRequired', to: 'financeNeeded' });
  await until(store, state => !state.held);
  store.dispose();
});
