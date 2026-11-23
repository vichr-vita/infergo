// Pure keyboard movement for the list view: plain arrows step through rules in
// the order shown; while a fact is held they step only through rules that can
// take it.
export function stepThrough(order: readonly string[], current: string | undefined, step: 1 | -1, allowed?: ReadonlySet<string>): string | undefined {
  const candidates = allowed ? order.filter(id => allowed.has(id)) : order;
  if (!candidates.length) return undefined;
  if (current === undefined) return step > 0 ? candidates[0] : candidates.at(-1);
  const at = candidates.indexOf(current);
  if (at >= 0) return candidates[Math.max(0, Math.min(candidates.length - 1, at + step))];
  // The current rule is not a candidate (a refused target): move to the next candidate after it in list order.
  const position = order.indexOf(current);
  const after = candidates.filter(id => (order.indexOf(id) - position) * step > 0);
  return step > 0 ? after[0] ?? candidates.at(-1) : after.at(-1) ?? candidates[0];
}
