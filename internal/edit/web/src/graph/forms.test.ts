import assert from 'node:assert/strict';
import test from 'node:test';
import { factNameProblem, ruleNameProblem } from './forms';

test('a rule name must be an exported Go name that is not taken', () => {
  const taken = (name: string) => name === 'CappedBonus';
  assert.equal(ruleNameProblem('LoyaltyTopUp', taken), undefined);
  assert.equal(ruleNameProblem('Ünder_2', taken), undefined);
  assert.equal(ruleNameProblem('CappedBonus', taken), 'A rule named CappedBonus already exists.');
  assert.match(ruleNameProblem('loyalty', taken)!, /not an exported Go name/);
  assert.match(ruleNameProblem('Loyalty-TopUp', taken)!, /not an exported Go name/);
  assert.equal(ruleNameProblem('', taken), 'Enter a rule name.');
});

test('a fact name must be a Go name and not a keyword', () => {
  assert.equal(factNameProblem('loyaltyTopUpCents'), undefined);
  assert.equal(factNameProblem('_hidden'), undefined);
  assert.match(factNameProblem('range')!, /not a Go name/);
  assert.match(factNameProblem('2fast')!, /not a Go name/);
});
