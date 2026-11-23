// History tab. A plain stub from workstream E part 1: every entry with its
// files, outside edits and entries that can no longer be undone marked in
// words. E part 2 replaces this file tree.
import { h } from '../dom';
import type { Region } from '../region';

export const mount: Region = (root, store) => {
  const list = h('ol', { class: 'history-list', 'aria-label': 'History, newest last' });
  const empty = h('p', {}, 'No changes yet.');
  root.append(empty, list);
  store.watch(s => s.history, history => {
    empty.hidden = history.entries.length > 0;
    list.replaceChildren(...history.entries.map((entry, index) => {
      const notes = [
        entry.source === 'disk' ? 'Outside edit' : '',
        index >= history.cursor ? 'Undone' : '',
        entry.undoable === false ? 'Can no longer be undone here' : '',
        entry.note ?? '',
      ].filter(Boolean);
      return h('li', { class: entry.source === 'disk' ? 'row-refused' : index >= history.cursor ? 'dim' : undefined },
        h('span', {}, entry.label),
        h('span', { class: 'mono history-files' }, entry.files.map(file => `${file.path} +${file.added} −${file.removed}`).join(', ')),
        notes.length > 0 && h('span', { class: 'history-notes' }, notes.join('. ')));
    }));
  });
};
