// Facts column. A minimal working stub from workstream E part 1: inputs,
// outputs, and derived facts, filtered by Find. Click or W picks a fact up,
// clicking the held fact puts it down, hover and focus light it everywhere.
// E part 2 replaces this file tree (pointer drag, add input, request output).
import { h, reconcile, setText } from '../dom';
import type { Region } from '../region';
import { matchesQuery, type State } from '../store';
import type { FactInfo } from '../derive';

type Section = { key: string; title: string; facts: (state: State) => FactInfo[] };

const sections: Section[] = [
  { key: 'inputs', title: 'Inputs', facts: s => [...s.graph.facts.values()].filter(fact => fact.input) },
  { key: 'outputs', title: 'Outputs', facts: s => [...s.graph.facts.values()].filter(fact => fact.requested) },
  { key: 'derived', title: 'Derived', facts: s => [...s.graph.facts.values()].filter(fact => fact.producers.length) },
];

export const mount: Region = (root, store) => {
  const parts = sections.map(section => {
    const count = h('span', { class: 'count' });
    const list = h('ul', { class: 'fact-list', 'aria-label': section.title });
    root.append(h('h3', { class: 'section-heading' }, section.title, count), list);
    return { section, count, list };
  });

  store.watch(s => [s.graph, s.query, s.highlight, s.held?.fact.name], () => {
    const state = store.state;
    for (const { section, count, list } of parts) {
      const all = section.facts(state);
      const shown = all.filter(fact => matchesQuery(state, fact.name, fact.type));
      setText(count, String(all.length));
      reconcile(list, shown, fact => fact.name, fact => {
        const button = h('button', { type: 'button', class: 'fact-row' }, h('span', { class: 'fact-name' }), h('span', { class: 'fact-type' }));
        button.addEventListener('click', () => {
          if (store.state.held?.fact.name === fact.name) store.cancel();
          else store.hold(fact.name);
        });
        button.addEventListener('keydown', event => {
          if (event.key.toLowerCase() !== 'w' || event.ctrlKey || event.metaKey || event.altKey) return;
          event.preventDefault();
          store.hold(fact.name);
        });
        for (const type of ['pointerenter', 'focus']) button.addEventListener(type, () => store.highlight(fact.name));
        for (const type of ['pointerleave', 'blur']) button.addEventListener(type, () => store.highlight(undefined));
        return h('li', {}, button);
      }, (li, fact) => {
        const button = li.firstElementChild as HTMLButtonElement;
        setText(button.children[0]!, fact.name);
        setText(button.children[1]!, fact.type);
        const held = state.held?.fact.name === fact.name;
        button.classList.toggle('lit', held || state.highlight === fact.name);
        button.setAttribute('aria-pressed', String(held));
        button.setAttribute('aria-label', `${fact.name} ${fact.type}${held ? ', held' : ''}`);
      });
    }
  });
};
