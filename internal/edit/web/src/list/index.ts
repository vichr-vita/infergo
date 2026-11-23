// List view: the rules as text in dependency order. A plain stub from
// workstream E part 1. It is the layout below 1100 px and a toggle above it.
// Below 1100 px it opens the rule detail (sheet and code pane) under the
// selected rule through shell.placeRuleDetail, and lists that rule first. While a fact is held, rules
// that can take it are outlined and the rest dimmed; hovering aims and
// clicking drops. E part 2 replaces this file tree.
import { h, reconcile, setText } from '../dom';
import type { Region } from '../region';
import { matchesQuery } from '../store';
import type { Rule } from '../protocol';

export const mount: Region = (root, store, shell) => {
  const canvas = h('button', { type: 'button' }, 'Canvas');
  canvas.addEventListener('click', () => store.setListView(false));
  const list = h('ol', { class: 'rule-list', 'aria-label': 'Rules in dependency order' });
  root.append(h('div', { class: 'list-heading' }, h('h3', { class: 'section-heading' }, 'Rules'), canvas), list);

  store.watch(s => [s.graph, s.query, s.selection.rule, s.held, s.narrow], () => {
    const state = store.state;
    canvas.hidden = state.narrow;
    let rules = state.graph.order.map(id => state.graph.rules.get(id)!)
      .filter(rule => rule.id === state.selection.rule || matchesQuery(state, rule.id, rule.requirement, ...rule.reads.map(f => f.name), ...rule.produces.map(f => f.name)));
    // On a phone the selected rule and its open detail come first.
    if (state.narrow) rules = [...rules.filter(rule => rule.id === state.selection.rule), ...rules.filter(rule => rule.id !== state.selection.rule)];
    reconcile(list, rules, rule => rule.id, rule => {
      const button = h('button', { type: 'button', class: 'rule-name' });
      button.addEventListener('click', () => {
        if (store.state.held) { store.aim(rule.id); void store.drop(); } else store.select({ rule: rule.id });
      });
      const li = h('li', {}, button, h('p', { class: 'rule-requirement' }), h('p', { class: 'rule-io mono' }));
      li.addEventListener('pointerenter', () => store.aim(rule.id));
      li.addEventListener('pointerleave', () => { if (store.state.held?.over === rule.id) store.aim(undefined); });
      return li;
    }, (li, rule: Rule) => {
      const verdict = state.held?.verdicts.get(rule.id);
      setText(li.children[0]!, `${rule.id}()`);
      setText(li.children[1]!, rule.requirement);
      setText(li.children[2]!, `reads ${rule.reads.map(f => f.name).join(', ') || 'nothing'} → ${rule.produces.map(f => f.name).join(', ') || 'nothing'}`);
      li.children[0]!.setAttribute('aria-current', String(rule.id === state.selection.rule));
      li.classList.toggle('selected', rule.id === state.selection.rule);
      li.classList.toggle('target', !!verdict?.ok);
      li.classList.toggle('dim', !!verdict && !verdict.ok);
    });
    const selected = list.querySelector<HTMLElement>('li.selected');
    shell.placeRuleDetail(state.narrow && selected ? selected : undefined);
  });
};
