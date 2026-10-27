import type { ReadRange } from '@between-pages/contracts';

// Sets of characters by identity: per clientID, sorted disjoint clock intervals [from, to).

export type Coverage = Map<number, [number, number][]>;

function normalized(intervals: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [from, to] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else if (from < to) out.push([from, to]);
  }
  return out;
}

export function coverageOf(ranges: readonly ReadRange[]): Coverage {
  const grouped: Coverage = new Map();
  for (const { clientId, from, to } of ranges)
    grouped.set(clientId, [...(grouped.get(clientId) ?? []), [from, to]]);
  for (const [client, intervals] of grouped) grouped.set(client, normalized(intervals));
  return grouped;
}

export function rangesOf(coverage: Coverage): ReadRange[] {
  return [...coverage].flatMap(([clientId, intervals]) =>
    intervals.map(([from, to]) => ({ clientId, from, to })),
  );
}

export function union(a: Coverage, b: Coverage): Coverage {
  const out: Coverage = new Map(a);
  for (const [client, intervals] of b)
    out.set(client, normalized([...(out.get(client) ?? []), ...intervals]));
  return out;
}

export function intersection(a: Coverage, b: Coverage): Coverage {
  const out: Coverage = new Map();
  for (const [client, left] of a) {
    const right = b.get(client) ?? [];
    const both: [number, number][] = [];
    for (const [f1, t1] of left)
      for (const [f2, t2] of right) {
        const from = Math.max(f1, f2);
        const to = Math.min(t1, t2);
        if (from < to) both.push([from, to]);
      }
    if (both.length) out.set(client, normalized(both));
  }
  return out;
}

/** Characters of `a` not in `b`. */
export function difference(a: Coverage, b: Coverage): Coverage {
  const out: Coverage = new Map();
  for (const [client, intervals] of a) {
    let rest = intervals;
    for (const [from, to] of b.get(client) ?? [])
      rest = rest.flatMap(([f, t]): [number, number][] =>
        to <= f || from >= t
          ? [[f, t]]
          : (
              [
                [f, Math.max(f, from)],
                [Math.min(t, to), t],
              ] as [number, number][]
            ).filter(([x, y]) => x < y),
      );
    if (rest.length) out.set(client, rest);
  }
  return out;
}
