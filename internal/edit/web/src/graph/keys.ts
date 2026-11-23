// Which rule or wire an arrow key moves to. Pure, so keys.test.ts checks it
// against positions without a DOM. index.ts passes the placed node and label
// rectangles.
import type { Graph, Wire } from '../derive';
import { wireKey } from '../derive';
import type { Rect } from './layout';

export type Direction = 'up' | 'down' | 'left' | 'right';

const centre = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

/**
 * The rule an arrow key moves to from `from`, following wires: Up to a rule it
 * reads from, Down to a rule that reads from it, Left and Right to the nearest
 * rule in the same rank. Among several, the one closest horizontally wins.
 */
export function neighbour(graph: Graph, nodes: ReadonlyMap<string, Rect>, from: string, direction: Direction): string | undefined {
  const here = nodes.get(from);
  if (!here) return undefined;
  const origin = centre(here);
  let candidates: string[];
  if (direction === 'up') candidates = graph.wires.filter(wire => wire.to === from).map(wire => wire.from);
  else if (direction === 'down') candidates = graph.wires.filter(wire => wire.from === from).map(wire => wire.to);
  else {
    // dagre centres every node of a rank on the same y.
    candidates = [...nodes].filter(([id, rect]) => {
      if (id === from || Math.abs(centre(rect).y - origin.y) > 1) return false;
      return direction === 'left' ? centre(rect).x < origin.x : centre(rect).x > origin.x;
    }).map(([id]) => id);
  }
  let best: string | undefined;
  let bestScore = Infinity;
  for (const id of new Set(candidates)) {
    if (id === from) continue;
    const rect = nodes.get(id);
    if (!rect) continue;
    const point = centre(rect);
    const score = Math.abs(point.x - origin.x) * 1000 + Math.abs(point.y - origin.y);
    if (score < bestScore) { best = id; bestScore = score; }
  }
  return best;
}

/** Reading order: top to bottom, then left to right. */
function readingOrder(nodes: ReadonlyMap<string, Rect>, a: string, b: string): number {
  const first = nodes.get(a), second = nodes.get(b);
  if (!first || !second) return 0;
  const dy = centre(first).y - centre(second).y;
  return Math.abs(dy) > 1 ? dy : centre(first).x - centre(second).x;
}

/**
 * While a fact is held, arrows step only through rules that can take it, in
 * reading order. Down and Right go forward, Up and Left go back, wrapping at
 * the ends. From a rule that is not a target, the step goes to the next
 * target after it in reading order (or the one before, going back).
 */
export function stepTarget(nodes: ReadonlyMap<string, Rect>, targets: readonly string[], from: string | undefined, direction: Direction): string | undefined {
  const ordered = targets.filter(id => nodes.has(id)).sort((a, b) => readingOrder(nodes, a, b));
  if (!ordered.length) return undefined;
  const forward = direction === 'down' || direction === 'right';
  const index = from ? ordered.indexOf(from) : -1;
  if (index >= 0) return ordered[(index + (forward ? 1 : -1) + ordered.length) % ordered.length];
  if (!from || !nodes.has(from)) return forward ? ordered[0] : ordered[ordered.length - 1];
  if (forward) return ordered.find(id => readingOrder(nodes, id, from) > 0) ?? ordered[0];
  return [...ordered].reverse().find(id => readingOrder(nodes, id, from) < 0) ?? ordered[ordered.length - 1];
}

/** Wires into a rule (`in`) or out of it (`out`), left to right by where their labels sit. */
export function wiresAt(graph: Graph, labels: ReadonlyMap<string, Rect>, rule: string, side: 'in' | 'out'): Wire[] {
  const x = (wire: Wire) => {
    const rect = labels.get(wireKey(wire));
    return rect ? rect.x + rect.width / 2 : 0;
  };
  return graph.wires.filter(wire => (side === 'in' ? wire.to : wire.from) === rule).sort((a, b) => x(a) - x(b));
}
