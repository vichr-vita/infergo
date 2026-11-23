// Graph canvas. An honest placeholder from workstream E part 1 until
// workstream F lands the canvas: the heading with the List toggle, and every
// rule as a plain button. Hovering a rule aims a held fact at it, clicking
// drops it there or selects the rule. Workstream F replaces this file tree.
import { h, reconcile, setText } from '../dom';
import type { Region } from '../region';
import { matchesQuery } from '../store';

export const mount: Region = (root, store) => {
  const title = h('span', { class: 'graph-title' });
  const list = h('button', { type: 'button' }, 'List');
  list.addEventListener('click', () => store.setListView(true));
  const rules = h('ul', { class: 'graph-stub-rules', 'aria-label': 'Rules' });
  root.append(
    h('div', { class: 'graph-heading' }, title, list),
    h('div', { class: 'graph-stub' }, h('p', {}, 'The canvas is not built yet. Every rule is listed here in source order.'), rules),
  );
  store.watch(s => [s.graph, s.query, s.selection.rule, s.held], () => {
    const state = store.state;
    setText(title, `${state.model.package} · rule dependencies`);
    const shown = [...state.graph.rules.values()].filter(rule => matchesQuery(state, rule.id, ...rule.reads.map(f => f.name), ...rule.produces.map(f => f.name)));
    reconcile(rules, shown, rule => rule.id, rule => {
      const button = h('button', { type: 'button', 'data-rule': rule.id });
      button.addEventListener('pointerenter', () => store.aim(rule.id));
      button.addEventListener('pointerleave', () => { if (store.state.held?.over === rule.id) store.aim(undefined); });
      button.addEventListener('click', () => {
        if (store.state.held) { store.aim(rule.id); void store.drop(); } else store.select({ rule: rule.id });
      });
      return h('li', {}, button);
    }, (li, rule) => {
      const button = li.firstElementChild as HTMLButtonElement;
      const verdict = state.held?.verdicts.get(rule.id);
      setText(button, `${rule.id}()`);
      button.setAttribute('aria-current', String(rule.id === state.selection.rule));
      button.classList.toggle('target', !!verdict?.ok);
      button.classList.toggle('dim', !!verdict && !verdict.ok);
    });
  });
};
