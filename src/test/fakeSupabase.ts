// Minimal stand-in for the @supabase/supabase-js query builder, used to unit
// test userbase routes without touching the (production-only) Supabase
// project. Each `.from(table)` call is answered from a per-table queue of
// canned results, consumed in call order; the last queued result repeats if
// the queue runs out. Every builder call resolves via `.then`, so both
// `await x.insert(...)` and `await x.insert(...).select().single()` work.

export type FakeResult = { data: any; error: any };

export function makeFakeSupabase(responses: Record<string, FakeResult[]>) {
  const callIndex: Record<string, number> = {};

  function from(table: string) {
    const i = callIndex[table] ?? 0;
    callIndex[table] = i + 1;
    const queue = responses[table] || [];
    const result: FakeResult = queue[i] ?? queue[queue.length - 1] ?? { data: null, error: null };

    const builder: any = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => Promise.resolve(result),
      insert: () => builder,
      upsert: () => Promise.resolve(result),
      update: () => builder,
      single: () => Promise.resolve(result),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    };
    return builder;
  }

  return { from, callCounts: callIndex };
}
