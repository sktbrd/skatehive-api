// Minimal stand-in for the @supabase/supabase-js query builder, used to unit
// test routes/resolvers without touching the (production-only) Supabase
// project. Each `.from(table)` call is answered from a per-table queue of
// canned results, consumed in call order; the last queued result repeats if
// the queue runs out. Every builder call resolves via `.then`, so both
// `await x.insert(...)` and `await x.insert(...).select().single()` work.
// Every call (table + method + args) is also recorded in `calls` so tests can
// assert on what was written, not just what was read.

export type FakeResult = { data: any; error: any };
export type FakeCall = { table: string; method: string; args: any[] };

export function makeFakeSupabase(responses: Record<string, FakeResult[]>) {
  const callIndex: Record<string, number> = {};
  const calls: FakeCall[] = [];

  function from(table: string) {
    const i = callIndex[table] ?? 0;
    callIndex[table] = i + 1;
    const queue = responses[table] || [];
    const result: FakeResult = queue[i] ?? queue[queue.length - 1] ?? { data: null, error: null };

    const record = (method: string, args: any[]) => calls.push({ table, method, args });

    // Every method just records the call and returns `builder` again — only
    // `.then()` actually resolves, so any method (including the type-only
    // `.returns<T>()`) can be the last one in a chain and still await correctly.
    const builder: any = {
      select: (...a: any[]) => { record("select", a); return builder; },
      eq: (...a: any[]) => { record("eq", a); return builder; },
      order: (...a: any[]) => { record("order", a); return builder; },
      limit: (...a: any[]) => { record("limit", a); return builder; },
      insert: (...a: any[]) => { record("insert", a); return builder; },
      upsert: (...a: any[]) => { record("upsert", a); return builder; },
      update: (...a: any[]) => { record("update", a); return builder; },
      delete: (...a: any[]) => { record("delete", a); return builder; },
      single: () => { record("single", []); return builder; },
      maybeSingle: () => { record("maybeSingle", []); return builder; },
      returns: () => builder, // type-only in real supabase-js; no runtime effect
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    };
    return builder;
  }

  return { from, callCounts: callIndex, calls };
}
