// Code pane. A read-only stub from workstream E part 1: the shown rule's
// source, or the pending preview's version of it. Workstream G replaces this
// file tree with the CodeMirror pane.
import { h, setText } from '../dom';
import type { Region } from '../region';
import { previewChange, shownRule } from '../store';

export const mount: Region = (root, store) => {
  const state = h('span', { class: 'code-state' });
  const code = h('code');
  root.append(h('h3', { class: 'section-heading' }, 'Source', h('span', { class: 'push' }, state)), h('pre', { class: 'code-stub' }, code));
  store.watch(s => [shownRule(s), s.preview], () => {
    const rule = shownRule(store.state);
    root.hidden = !rule;
    if (!rule) return;
    const change = previewChange(store.state, rule.id);
    setText(state, change ? 'Preview, not written' : `${rule.file}:${rule.line}`);
    state.classList.toggle('text-teal', !!change);
    setText(code, change ? change.after : rule.source);
    code.classList.toggle('pending', !!change);
  });
};
