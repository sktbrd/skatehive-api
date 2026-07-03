import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks -----------------------------------------------------------------
// HAFSQL is mocked so the route needs no DB connection (and its module-scope
// `new HAFSQL_Database()` doesn't throw on missing env vars).
const { mockExecuteQuery } = vi.hoisted(() => ({ mockExecuteQuery: vi.fn() }));
vi.mock('@/lib/hafsql_database', () => ({
  HAFSQL_Database: vi.fn(() => ({ executeQuery: mockExecuteQuery })),
}));

// dealiasSoftPosts hits Supabase; mock it so we can assert the route delegates
// to it and returns its result. normalizePost + cacheHeaders run for real.
const { mockDealias } = vi.hoisted(() => ({ mockDealias: vi.fn() }));
vi.mock('@/lib/soft-posts', () => ({
  dealiasSoftPosts: mockDealias,
  extractSafeUser: vi.fn(),
}));

// Imported after mocks are registered (vi.mock is hoisted above imports anyway).
import { GET } from '@/app/api/v2/post/[author]/[permlink]/route';

// --- Helpers ---------------------------------------------------------------
const rawRow = (overrides: Record<string, unknown> = {}) => ({
  author: 'xvlad',
  permlink: 'sh-20260703t042512',
  parent_author: 'peak.snaps',
  parent_permlink: 'snap-container-abc',
  body: '  hello world  ',
  created: '2026-07-03T04:25:12',
  post_json_metadata: '{"app":"skatehive"}',
  category: 'hive-173115',
  pending_payout_value: '1.234',
  children: '3',
  reputation: 25,
  followers: 10,
  followings: 5,
  votes: [
    { id: 1, voter: 'bob', weight: 100, rshares: '5', total_vote_weight: '0', pending_payout: '0', timestamp: '2026-07-03T04:26:00' },
  ],
  ...overrides,
});

const invoke = (author: string, permlink: string) =>
  GET({} as never, { params: Promise.resolve({ author, permlink }) });

beforeEach(() => {
  vi.clearAllMocks();
  // Default: dealias is a passthrough so normalizePost output flows unchanged.
  mockDealias.mockImplementation(async (posts: unknown[]) => posts);
});

// --- Tests -----------------------------------------------------------------
describe('GET /api/v2/post/[author]/[permlink]', () => {
  it('returns 200 with a normalized post and 300s edge-cache headers', async () => {
    mockExecuteQuery.mockResolvedValue({ rows: [rawRow()], headers: [] });

    const res = await invoke('xvlad', 'sh-20260703t042512');
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.author).toBe('xvlad');
    expect(json.data.permlink).toBe('sh-20260703t042512');
    expect(json.data.body).toBe('hello world'); // normalizePost trims
    expect(json.data.children).toBe(3); // coerced to number
    expect(json.data.votes).toHaveLength(1);
    expect(res.headers.get('CDN-Cache-Control')).toBe('s-maxage=300, stale-while-revalidate=150');
    expect(res.headers.get('Vercel-CDN-Cache-Control')).toBe('s-maxage=300, stale-while-revalidate=150');
  });

  it('parameterizes the query with author and permlink (no string interpolation)', async () => {
    mockExecuteQuery.mockResolvedValue({ rows: [rawRow()], headers: [] });

    await invoke('xvlad', 'sh-20260703t042512');

    const [, params] = mockExecuteQuery.mock.calls[0];
    expect(params).toEqual([
      { name: 'author', value: 'xvlad' },
      { name: 'permlink', value: 'sh-20260703t042512' },
    ]);
  });

  it('runs the post through dealiasSoftPosts and returns the de-aliased result', async () => {
    mockExecuteQuery.mockResolvedValue({ rows: [rawRow({ author: 'skateuser' })], headers: [] });
    mockDealias.mockImplementation(async (posts: any[]) =>
      posts.map(p => ({ ...p, is_soft_post: true, soft_post_display_name: 'Ricardo' }))
    );

    const res = await invoke('skateuser', 'some-uuid');
    const json = await res.json();

    expect(mockDealias).toHaveBeenCalledTimes(1);
    const [batch] = mockDealias.mock.calls[0];
    expect(batch).toHaveLength(1);
    expect(batch[0].author).toBe('skateuser');
    expect(json.data.is_soft_post).toBe(true);
    expect(json.data.soft_post_display_name).toBe('Ricardo');
  });

  it('returns 404 with a short cache when the post does not exist', async () => {
    mockExecuteQuery.mockResolvedValue({ rows: [], headers: [] });

    const res = await invoke('xvlad', 'nope');
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toEqual({ success: false, error: 'Post not found' });
    expect(res.headers.get('CDN-Cache-Control')).toBe('s-maxage=60, stale-while-revalidate=30');
    expect(mockDealias).not.toHaveBeenCalled();
  });

  it('returns 500 without cache headers when the query throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExecuteQuery.mockRejectedValue(new Error('db down'));

    const res = await invoke('xvlad', 'boom');
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({ success: false, error: 'Failed to fetch post' });
    expect(res.headers.get('CDN-Cache-Control')).toBeNull();
  });
});
