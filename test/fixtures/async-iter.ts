/** Tiny helpers for feeding / draining async iterables in adapter tests. */

export async function* fromArray<T>(items: T[]): AsyncGenerator<T, void, unknown> {
  for (const item of items) yield item;
}

export async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}
