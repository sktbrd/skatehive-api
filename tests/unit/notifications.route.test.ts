import { describe, it, expect, beforeEach, vi } from 'vitest';

// HiveClient is mocked so the route makes no RPC calls.
const { mockCall } = vi.hoisted(() => ({ mockCall: vi.fn() }));
vi.mock('@/lib/hive-client', () => ({ HiveClient: { call: mockCall } }));

import { GET } from '@/app/api/v2/notifications/[username]/route';

// --- Helpers ---------------------------------------------------------------
const notif = (id: number, date: string) => ({
  id,
  type: 'reply',
  score: 40,
  date,
  msg: `notification ${id}`,
  url: `@alice/post-${id}`,
});

const historyWithNotify = (date: string) => ({
  history: [
    [0, { op: { value: { id: 'notify', json: JSON.stringify(['setLastRead', { date }]) } } }],
  ],
});

// Route the two appbase calls the endpoint makes. `lastRead` may be a value,
// an Error (rejects), or a function of the history-scan params for recursion.
const wire = (opts: { notifications?: unknown; lastRead?: unknown }) => {
  mockCall.mockImplementation((api: string, _method: string, params: any) => {
    if (api === 'bridge') {
      if (opts.notifications instanceof Error) return Promise.reject(opts.notifications);
      return Promise.resolve(opts.notifications);
    }
    if (api === 'account_history_api') {
      if (opts.lastRead instanceof Error) return Promise.reject(opts.lastRead);
      if (typeof opts.lastRead === 'function') return Promise.resolve(opts.lastRead(params));
      return Promise.resolve(opts.lastRead);
    }
    return Promise.resolve(undefined);
  });
};

const invoke = (username: string, query = '') =>
  GET(
    { url: `http://localhost/api/v2/notifications/${username}${query}` } as never,
    { params: Promise.resolve({ username }) }
  );

beforeEach(() => vi.clearAllMocks());

// --- Tests -----------------------------------------------------------------
describe('GET /api/v2/notifications/[username]', () => {
  it('returns notifications with per-item isRead, unread count and 30s edge-cache headers', async () => {
    wire({
      notifications: [
        notif(1, '2026-07-03T05:00:00'),
        notif(2, '2026-07-03T04:00:00'),
        notif(3, '2026-07-03T02:00:00'),
      ],
      lastRead: historyWithNotify('2026-07-03T03:00:00'),
    });

    const res = await invoke('alice');
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.notifications.map((n: any) => n.isRead)).toEqual([false, false, true]);
    expect(json.data.lastRead).toBe('2026-07-03T03:00:00');
    expect(json.data.unread).toBe(2);
    expect(res.headers.get('CDN-Cache-Control')).toBe('s-maxage=30, stale-while-revalidate=15');
  });

  it('clamps limit to the bridge max of 100 and floors at 1', async () => {
    wire({ notifications: [], lastRead: { history: [] } });

    await invoke('alice', '?limit=999');
    expect(mockCall).toHaveBeenCalledWith('bridge', 'account_notifications', { account: 'alice', limit: 100 });

    mockCall.mockClear();
    await invoke('alice', '?limit=0');
    expect(mockCall).toHaveBeenCalledWith('bridge', 'account_notifications', { account: 'alice', limit: 100 });

    mockCall.mockClear();
    await invoke('alice', '?limit=5');
    expect(mockCall).toHaveBeenCalledWith('bridge', 'account_notifications', { account: 'alice', limit: 5 });
  });

  it('forwards last_id for pagination when provided', async () => {
    wire({ notifications: [], lastRead: { history: [] } });

    await invoke('alice', '?last_id=42&limit=10');
    expect(mockCall).toHaveBeenCalledWith('bridge', 'account_notifications', {
      account: 'alice',
      limit: 10,
      last_id: 42,
    });
  });

  it('treats everything as unread when no setLastRead exists (epoch default)', async () => {
    wire({
      notifications: [notif(1, '2026-07-03T05:00:00'), notif(2, '2026-07-03T04:00:00')],
      lastRead: { history: [] },
    });

    const res = await invoke('alice');
    const json = await res.json();

    expect(json.data.lastRead).toBe('1970-01-01T00:00:00Z');
    expect(json.data.unread).toBe(2);
    expect(json.data.notifications.every((n: any) => n.isRead === false)).toBe(true);
  });

  it('walks back through history pages to find the notify op', async () => {
    // First page (start=-1) has no notify; second page (start=-1001) does.
    wire({
      notifications: [notif(1, '2026-07-03T05:00:00')],
      lastRead: (params: any) =>
        params.start === -1
          ? { history: [[0, { op: { value: { id: 'vote', json: '{}' } } }]] }
          : historyWithNotify('2026-07-03T06:00:00'),
    });

    const res = await invoke('alice');
    const json = await res.json();

    expect(json.data.lastRead).toBe('2026-07-03T06:00:00');
    expect(json.data.unread).toBe(0); // the one notification predates lastRead
    // 1 bridge call + 2 history pages
    expect(mockCall).toHaveBeenCalledTimes(3);
  });

  it('still returns 200 (all unread) when the history scan fails', async () => {
    wire({
      notifications: [notif(1, '2026-07-03T05:00:00')],
      lastRead: new Error('history rpc down'),
    });

    const res = await invoke('alice');
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.lastRead).toBe('1970-01-01T00:00:00Z');
    expect(json.data.unread).toBe(1);
  });

  it('returns 500 without cache headers when the notifications fetch throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wire({ notifications: new Error('bridge down') });

    const res = await invoke('alice');
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({ success: false, error: 'Failed to fetch notifications' });
    expect(res.headers.get('CDN-Cache-Control')).toBeNull();
  });
});
