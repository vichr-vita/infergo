import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveGraph } from '../derive';
import { fixtures } from '../fixtures.check';
import { factNameProblem, modelTypes, requirementIsEmpty, ruleNameProblem, typeProblem, withLeadingName } from './names';

const graph = deriveGraph(fixtures.model);

test('fact names must be new Go identifiers', () => {
  assert.equal(factNameProblem('loyaltyCents', graph), undefined);
  assert.equal(factNameProblem('', graph), 'Enter a name.');
  assert.match(factNameProblem('2fast', graph)!, /letters, digits/);
  assert.equal(factNameProblem('range', graph), 'range is a Go keyword.');
  assert.equal(factNameProblem('salaryCents', graph), 'A fact named salaryCents already exists.');
  assert.equal(factNameProblem('salaryCents', graph, 'salaryCents'), undefined);
});

test('rule names are exported and new', () => {
  assert.equal(ruleNameProblem('LoyaltyTopUp', graph), undefined);
  assert.equal(ruleNameProblem('loyaltyTopUp', graph), 'A rule name starts with a capital letter.');
  assert.equal(ruleNameProblem('FinalBonus', graph), 'A rule named FinalBonus already exists.');
});

test('types accept names, pointers, slices, maps, and qualified names', () => {
  for (const type of ['uint64', '*string', '[]Role', 'map[string]int', 'time.Duration']) assert.equal(typeProblem(type), undefined, type);
  assert.ok(typeProblem(''));
  assert.ok(typeProblem('chan int'));
  assert.ok(typeProblem('**'));
});

test('the rule name is put back as the first word of a requirement', () => {
  assert.equal(withLeadingName('FinalBonus releases the bonus.', 'FinalBonus'), 'FinalBonus releases the bonus.');
  assert.equal(withLeadingName('  releases\n the   bonus. ', 'FinalBonus'), 'FinalBonus releases the bonus.');
  assert.equal(withLeadingName('FinalBonusX pays', 'FinalBonus'), 'FinalBonus FinalBonusX pays');
  assert.ok(requirementIsEmpty('  FinalBonus ', 'FinalBonus'));
  assert.ok(requirementIsEmpty('', 'FinalBonus'));
  assert.ok(!requirementIsEmpty('pays', 'FinalBonus'));
});

test('model types are unique and sorted', () => {
  const types = modelTypes(fixtures.model);
  assert.ok(types.includes('uint64') && types.includes('*string') && types.includes('Role'));
  assert.equal(new Set(types).size, types.length);
  assert.deepEqual(types, [...types].sort((a, b) => a.localeCompare(b)));
});
