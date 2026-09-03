// Minimal stand-in for the @supabase/supabase-js query builder, used to unit
// test userbase routes without touching the (production-only) Supabase
// project. Each `.from(table)` call is answered from a per-table queue of
// canned results, consumed in call order; the last queued result repeats if
// the queue runs out. Every builder call resolves via `.then`, so both
// `await x.insert(...)` and `await x.insert(...).select().single()` work.

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

    const builder: any = {
      select: (...a: any[]) => { record("select", a); return builder; },
      eq: (...a: any[]) => { record("eq", a); return builder; },
      order: (...a: any[]) => { record("order", a); return builder; },
      limit: (...a: any[]) => { record("limit", a); return Promise.resolve(result); },
      insert: (...a: any[]) => { record("insert", a); return builder; },
      upsert: (...a: any[]) => { record("upsert", a); return Promise.resolve(result); },
      update: (...a: any[]) => { record("update", a); return builder; },
      delete: (...a: any[]) => { record("delete", a); return builder; },
      single: () => { record("single", []); return Promise.resolve(result); },
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    };
    return builder;
  }

  return { from, callCounts: callIndex, calls };
}
