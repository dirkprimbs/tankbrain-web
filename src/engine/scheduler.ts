// Attention: who gets the floor this cycle.
//
// Rank by salience and keep the top N. Grouping by model mattered for one
// local GPU; with hosted models it only keeps the order stable, but it is kept
// so the brain behaves exactly like the server version.

import type { Message } from "./bus";

export function salience(unread: Message[]): number {
  let score = 0;
  for (const m of unread) score += m.kind === "dm" || m.kind === "signal" ? 3 : m.kind === "input" ? 2 : 1;
  return score;
}

/** candidates: [agent, salience, model]. Returns the agents in run order. */
export function schedule<T>(candidates: [T, number, string][], loaded: string | null, limit: number): T[] {
  // stable sort by descending salience, like Python's sorted()
  const top = candidates.map((c, i) => [c, i] as const)
    .sort((p, q) => q[0][1] - p[0][1] || p[1] - q[1]).map(([c]) => c).slice(0, limit);
  const order: string[] = [];
  if (loaded && top.some((c) => c[2] === loaded)) order.push(loaded);
  for (const [, , model] of top) if (!order.includes(model)) order.push(model);
  return order.flatMap((model) => top.filter((c) => c[2] === model).map((c) => c[0]));
}
