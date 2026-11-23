import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtures } from './fixtures.check';
import { applyOp, mockApi, parseDecl, wrapComment } from './mock';
import type { Model, Op, Rule } from './protocol';

function applied(model: Model, op: Op): Model {
  const outcome = applyOp(model, op);
  if ('refusal' in outcome) throw new Error(`${op.op} refused: ${outcome.refusal.message}`);
  return outcome.model;
}
const rule = (model: Model, id: string): Rule => model.rules.find(r => r.id === id)!;

test('add_read appends a parameter, and remove_read restores the original bytes', () => {
  const added = applied(fixtures.model, { op: 'add_read', rule: 'ReviewRequired', fact: 'financeRequired', type: 'bool' });
  assert.match(rule(added, 'ReviewRequired').source, /func ReviewRequired\(cappedBonusCents uint64, approvalsSatisfied bool, financeRequired bool\) \(reviewRequired \*string\) \{/);
  assert.deepEqual(rule(added, 'ReviewRequired').reads.at(-1), { name: 'financeRequired', type: 'bool' });
  const removed = applied(added, { op: 'remove_read', rule: 'ReviewRequired', fact: 'financeRequired' });
  assert.equal(rule(removed, 'ReviewRequired').source, rule(fixtures.model, 'ReviewRequired').source);
});

test('add_read refuses a cycle with the path, and a duplicate', () => {
  const cycle = applyOp(fixtures.model, { op: 'add_read', rule: 'CappedBonus', fact: 'approvalsSatisfied', type: 'bool' });
  assert.ok('refusal' in cycle);
  assert.equal(cycle.refusal.reason, 'cycle');
  assert.deepEqual(cycle.refusal.related, ['CappedBonus', 'FinanceRequired', 'ApprovalsSatisfied']);
  const duplicate = applyOp(fixtures.model, { op: 'add_read', rule: 'FinalBonus', fact: 'cappedBonusCents', type: 'uint64' });
  assert.ok('refusal' in duplicate && duplicate.refusal.reason === 'exists');
  const missing = applyOp(fixtures.model, { op: 'remove_read', rule: 'Nope', fact: 'x' });
  assert.ok('refusal' in missing && missing.refusal.reason === 'not_found');
});

test('add_rule inserts a failing stub after the producer and delete_rule removes it', () => {
  const op: Op = { op: 'add_rule', name: 'LoyaltyTopUp', reads: [{ name: 'cappedBonusCents', type: 'uint64' }], produces: [{ name: 'loyaltyTopUpCents', type: 'uint64' }], after: 'CappedBonus' };
  const added = applied(fixtures.model, op);
  const ids = added.rules.map(r => r.id);
  assert.equal(ids[ids.indexOf('CappedBonus') + 1], 'LoyaltyTopUp');
  const stub = rule(added, 'LoyaltyTopUp');
  assert.equal(stub.source, [
    '// LoyaltyTopUp TODO: state the requirement.',
    'func LoyaltyTopUp(cappedBonusCents uint64) (loyaltyTopUpCents uint64, err error) {',
    '\treturn loyaltyTopUpCents, errors.New("LoyaltyTopUp is not implemented")',
    '}',
  ].join('\n'));
  assert.ok(stub.stub && stub.returnsError);
  // The next rule moved down by the stub's four lines and a blank line.
  assert.equal(rule(added, 'FinanceRequired').line, rule(fixtures.model, 'FinanceRequired').line + 5);
  assert.deepEqual(applied(added, { op: 'delete_rule', rule: 'LoyaltyTopUp' }).rules, fixtures.model.rules);
});

test('rename_fact updates the producer, readers, bodies, and contract tags', () => {
  const renamed = applied(fixtures.model, { op: 'rename_fact', fact: 'finalBonusCents', to: 'payoutCents' });
  assert.ok(rule(renamed, 'FinalBonus').produces.some(fact => fact.name === 'payoutCents'));
  for (const reader of ['PaymentReady', 'TotalCompensation']) {
    assert.ok(rule(renamed, reader).reads.some(fact => fact.name === 'payoutCents'), reader);
    assert.ok(!/\bfinalBonusCents\b/.test(rule(renamed, reader).source.split('\n').slice(1).join('\n')), reader);
  }
  assert.ok(renamed.outputs.fields.some(field => field.fact === 'payoutCents'));
  const taken = applyOp(fixtures.model, { op: 'rename_fact', fact: 'finalBonusCents', to: 'salaryCents' });
  assert.ok('refusal' in taken && taken.refusal.reason === 'exists');
});

test('set_requirement rewraps the doc comment at 80 columns', () => {
  const text = 'FinalBonus releases the capped bonus only when every approval passes and the finance team has signed off. BR-22.';
  const changed = applied(fixtures.model, { op: 'set_requirement', rule: 'FinalBonus', text });
  const doc = rule(changed, 'FinalBonus').source.split('\n').filter(line => line.startsWith('//'));
  assert.equal(doc.length, 2);
  assert.ok(doc.every(line => line.length <= 80));
  assert.equal(rule(changed, 'FinalBonus').requirement, text);
  assert.equal(rule(changed, 'FinalBonus').line, rule(fixtures.model, 'FinalBonus').line + 1);
  assert.deepEqual(wrapComment('short'), ['// short']);
});

test('replace_source reparses the signature and refuses bad text or a stale base', () => {
  const before = rule(fixtures.model, 'FinanceRequired');
  const text = before.source.replace('(cappedBonusCents uint64)', '(cappedBonusCents uint64, managerApproved bool)');
  const changed = applied(fixtures.model, { op: 'replace_source', rule: 'FinanceRequired', text, base: before.sourceHash });
  assert.deepEqual(rule(changed, 'FinanceRequired').reads.map(fact => fact.name), ['cappedBonusCents', 'managerApproved']);
  const broken = applyOp(fixtures.model, { op: 'replace_source', rule: 'FinanceRequired', text: before.source.slice(0, -1), base: before.sourceHash });
  assert.ok('refusal' in broken && broken.refusal.reason === 'syntax_error');
  assert.match(broken.refusal.message, /^line \d+:/);
  const stale = applyOp(fixtures.model, { op: 'replace_source', rule: 'FinanceRequired', text, base: 'old' });
  assert.ok('refusal' in stale && stale.refusal.reason === 'stale_base');
});

test('parses grouped names and a named error result', () => {
  const decl = parseDecl('// X does it.\nfunc X(ctx context.Context, a, b int) (sum int, err error) {\n\treturn a + b, nil\n}');
  assert.ok(typeof decl !== 'string');
  assert.deepEqual(decl.params, [{ name: 'ctx', type: 'context.Context' }, { name: 'a', type: 'int' }, { name: 'b', type: 'int' }]);
  assert.deepEqual(decl.results, [{ name: 'sum', type: 'int' }, { name: 'err', type: 'error' }]);
});

test('the computed check is clean on the fixture and reports a hand-made cycle', async () => {
  const api = mockApi({ latency: { request: 0, check: 0, values: 0 } });
  const checks: { ok: boolean; kinds: string[] }[] = [];
  api.subscribe({
    model: () => {}, history: () => {}, values: () => {}, connection: () => {},
    check: check => checks.push({ ok: check.ok, kinds: check.diagnostics.map(d => d.kind) }),
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(checks, [{ ok: true, kinds: [] }]);
  const capped = api.current().rules.find(r => r.id === 'CappedBonus')!;
  api.simulateDiskEdit('CappedBonus', capped.source.replace('employeeBudgetCents uint64)', 'employeeBudgetCents uint64, finalBonusCents uint64)'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(checks.at(-1)!.ok, false);
  assert.ok(checks.at(-1)!.kinds.includes('cycle'));
});
