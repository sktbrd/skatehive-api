import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockExecuteQuery } = vi.hoisted(() => ({ mockExecuteQuery: vi.fn() }));
vi.mock('@/lib/hafsql_database', () => ({
  HAFSQL_Database: vi.fn(() => ({ executeQuery: mockExecuteQuery })),
}));

import { GET } from '@/app/api/v2/comments/route';

const invoke = (query: string) =>
  GET({ url: `http://localhost/api/v2/comments${query}` } as never);

const sampleRow = { author: 'bob', permlink: 'p1', title: 't', body: 'b', votes: [] };

beforeEach(() => vi.clearAllMocks());

describe('GET /api/v2/comments', () => {
  it('returns the query rows on success (behavior unchanged by the fix)', async () => {
    mockExecuteQuery.mockResolvedValue({ rows: [sampleRow], headers: ['author'] });

    const res = await invoke('?pa=alice&pp=post-1');
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([sampleRow]);
  });

  it('binds parent_author/permlink as @-parameters, never interpolated into SQL', async () => {
    mockExecuteQuery.mockResolvedValue({ rows: [sampleRow], headers: [] });

    // Classic injection payload — must be passed as a bound value, not concatenated.
    const evil = "x' OR '1'='1";
    await invoke(`?pa=${encodeURIComponent(evil)}&pp=post-1`);

    const [sql, inputs] = mockExecuteQuery.mock.calls[0];
    expect(sql).toContain('@pa');
    expect(sql).toContain('@pp');
    expect(sql).not.toContain(evil); // payload is not in the SQL text
    expect(sql).not.toContain("'${"); // no template interpolation left behind
    expect(inputs).toEqual([
      { name: 'pa', value: evil },
      { name: 'pp', value: 'post-1' },
    ]);
  });

  it('returns 400 without querying when pa or pp is missing', async () => {
    const res = await invoke('?pa=alice');
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  it('returns 404 when no comments are found', async () => {
    mockExecuteQuery.mockResolvedValue({ rows: [], headers: [] });

    const res = await invoke('?pa=alice&pp=post-1');
    expect(res.status).toBe(404);
  });

  it('returns 500 when the query throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExecuteQuery.mockRejectedValue(new Error('db down'));

    const res = await invoke('?pa=alice&pp=post-1');
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({ success: false, error: 'Failed to fetch comments' });
  });
});
