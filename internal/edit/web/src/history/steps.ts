// Pure rows for the History tab: newest first, each with its place relative
// to the undo cursor and the number of undo or redo steps that "Undo to here"
// or "Redo to here" takes. A step range that crosses an entry that can no
// longer be undone gets no action, because the server would refuse it.
import type { History, Receipt } from '../protocol';

export type HistoryRow = {
  entry: Receipt;
  /** Applied entries sit before the cursor; undone ones at or after it. */
  undone: boolean;
  /** The newest applied entry: the state the files are in now. */
  current: boolean;
  /** Undo this entry and every newer applied one, or redo every undone entry up to and including this one. */
  action?: { direction: 'undo' | 'redo'; steps: number };
};

export function historyRows(history: History): HistoryRow[] {
  const { entries, cursor } = history;
  const blocked = (from: number, to: number) => entries.slice(from, to).some(entry => entry.undoable === false);
  return entries.map((entry, index): HistoryRow => {
    const undone = index >= cursor;
    const range: [number, number] = undone ? [cursor, index + 1] : [index, cursor];
    const steps = range[1] - range[0];
    return {
      entry, undone, current: index === cursor - 1,
      ...(blocked(...range) ? {} : { action: { direction: undone ? 'redo' : 'undo', steps } }),
    };
  }).reverse();
}

/** "14:06:40" in the viewer's local time, or the raw text when it does not parse. */
export function clockTime(time: string): string {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return time;
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
}
