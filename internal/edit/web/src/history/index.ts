// History tab: every write as a receipt, newest first. Each entry shows its
// sentence, the files with line counts, the time, whether it came from another
// editor, and whether it can still be undone here. A line marks where the
// undo cursor sits, and each entry offers Undo to here or Redo to here, which
// steps store.undo() or store.redo() until that entry flips, stopping at the
// first refusal.
import { h, reconcile, setText } from '../dom';
import type { Region } from '../region';
import { failureText, stepAndSettle } from '../widgets/actions';
import { clockTime, historyRows, type HistoryRow } from './steps';

type Item = { kind: 'entry'; row: HistoryRow } | { kind: 'cursor' };
type Parts = { label: HTMLElement; meta: HTMLElement; marks: HTMLElement; action: HTMLButtonElement };

export const mount: Region = (root, store, shell) => {
  const empty = h('p', { class: 'history-empty' }, 'No changes yet. Every change you make here or in another editor is listed, newest first.');
  const list = h('ol', { class: 'history-list', 'aria-label': 'History, newest first' });
  root.append(empty, list);
  const parts = new WeakMap<HTMLElement, Parts>();
  let busy = false;

  async function step(row: HistoryRow) {
    if (busy || !row.action) return;
    busy = true;
    list.setAttribute('aria-busy', 'true');
    const { direction, steps } = row.action;
    let done = 0;
    let refusal: string | undefined;
    for (; done < steps; done++) {
      refusal = failureText(await stepAndSettle(store, direction));
      if (refusal) break;
    }
    busy = false;
    list.removeAttribute('aria-busy');
    if (steps > 1) shell.announce(`${direction === 'undo' ? 'Undid' : 'Redid'} ${done} of ${steps} changes${refusal ? `. Stopped: ${refusal}` : ''}`);
  }

  store.watch(s => s.history, history => {
    empty.hidden = history.entries.length > 0;
    const rows = historyRows(history);
    const items: Item[] = [];
    for (const row of rows) {
      // The cursor line sits between the oldest undone entry and the newest applied one.
      if (row.current && rows.some(other => other.undone)) items.push({ kind: 'cursor' });
      items.push({ kind: 'entry', row });
    }
    if (history.cursor === 0 && history.entries.length) items.push({ kind: 'cursor' });
    reconcile(list, items, item => (item.kind === 'cursor' ? 'cursor' : String(item.row.entry.id)), item => {
      if (item.kind === 'cursor') return h('li', { class: 'history-cursor' }, 'Entries above this line are undone');
      const label = h('span', { class: 'history-label' });
      const meta = h('span', { class: 'history-meta mono' });
      const marks = h('span', { class: 'history-marks' });
      const action = h('button', { type: 'button', class: 'link history-action' });
      const li = h('li', {}, label, meta, marks, action);
      parts.set(li, { label, meta, marks, action });
      const id = item.row.entry.id;
      action.addEventListener('click', () => {
        const row = historyRows(store.state.history).find(candidate => candidate.entry.id === id);
        if (row) void step(row);
      });
      return li;
    }, (li, item) => {
      if (item.kind === 'cursor') return;
      const { row } = item;
      const { entry } = row;
      const p = parts.get(li)!;
      const blocked = entry.undoable === false;
      li.className = [
        row.current ? 'current' : '', row.undone ? 'undone' : '', entry.source === 'disk' ? 'disk' : '', blocked ? 'blocked' : '',
      ].filter(Boolean).join(' ');
      setText(p.label, entry.label);
      const files = entry.files.map(file => `${file.path} +${file.added} −${file.removed}`).join(', ');
      setText(p.meta, [files, clockTime(entry.time)].filter(Boolean).join(' · '));
      const marks = [
        row.current ? 'Current' : '',
        row.undone ? 'Undone' : '',
        entry.source === 'disk' ? 'Outside edit. Undo stops here for older entries in its files' : '',
        blocked ? 'Can no longer be undone here: its file changed outside the editor later. Your IDE or git still has it' : '',
        entry.note ?? '',
      ].filter(Boolean);
      setText(p.marks, marks.join('. '));
      p.marks.hidden = !marks.length;
      p.action.hidden = !row.action;
      if (row.action) {
        const { direction, steps } = row.action;
        setText(p.action, direction === 'undo' ? 'Undo to here' : 'Redo to here');
        p.action.setAttribute('aria-label', direction === 'undo'
          ? `Undo ${entry.label}${steps > 1 ? ` and ${steps - 1} newer ${steps === 2 ? 'change' : 'changes'}` : ''}`
          : `Redo up to ${entry.label}${steps > 1 ? `, ${steps} changes` : ''}`);
      }
    });
  });
};
