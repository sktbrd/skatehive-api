import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockExecuteQuery } = vi.hoisted(() => ({ mockExecuteQuery: vi.fn() }));
vi.mock('@/lib/hafsql_database', () => ({
  HAFSQL_Database: vi.fn(() => ({ executeQuery: mockExecuteQuery })),
}));

const { mockCall } = vi.hoisted(() => ({ mockCall: vi.fn() }));
vi.mock('@/lib/hive-client', () => ({ HiveClient: { call: mockCall } }));

import { GET } from '@/app/api/v2/chain/globals/route';

// --- Fixtures --------------------------------------------------------------
// HAFSQL raw integers: 180,000,000.000 HIVE and 291,600,000,000.000000 VESTS -> 1620 vests/hive
const HAF_ROW = {
  total_vesting_fund_hive: '180000000000',
  total_vesting_shares: '291600000000000000',
  vests_per_hive: '1620.0000000000000000',
  block_num: 107803821,
};
// Same values as RPC asset strings, so both paths normalize to identical numbers.
const RPC_DGPO = {
  total_vesting_fund_hive: '180000000.000 HIVE',
  total_vesting_shares: '291600000000.000000 VESTS',
  head_block_number: 107803821,
};
const REWARD_FUND = { reward_balance: '800000.000 HIVE', recent_claims: '123456789012345' };
const MEDIAN = { base: '0.300 HBD', quote: '1.000 HIVE' };

const wireHive = (opts: { dgpo?: unknown; reward?: unknown; median?: unknown } = {}) => {
  mockCall.mockImplementation((_api: string, method: string) => {
    if (method === 'get_dynamic_global_properties')
      return opts.dgpo instanceof Error ? Promise.reject(opts.dgpo) : Promise.resolve(opts.dgpo ?? RPC_DGPO);
    if (method === 'get_reward_fund')
      return opts.reward instanceof Error ? Promise.reject(opts.reward) : Promise.resolve(REWARD_FUND);
    if (method === 'get_current_median_history_price')
      return opts.median instanceof Error ? Promise.reject(opts.median) : Promise.resolve(MEDIAN);
    return Promise.resolve(undefined);
  });
};

beforeEach(() => vi.clearAllMocks());

// --- Tests -----------------------------------------------------------------
describe('GET /api/v2/chain/globals', () => {
  it('serves global properties from HAFSQL (no DGPO RPC) with reward fund + median and 300s cache', async () => {
    mockExecuteQuery.mockResolvedValue({ rows: [HAF_ROW], headers: [] });
    wireHive();

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.globalProperties).toEqual({
      total_vesting_fund_hive: 180000000,
      total_vesting_shares: 291600000000,
      vests_per_hive: 1620,
      head_block_number: 107803821,
      source: 'hafsql',
    });
    expect(json.data.rewardFund).toEqual(REWARD_FUND);
    expect(json.data.medianPrice).toEqual(MEDIAN);
    expect(res.headers.get('CDN-Cache-Control')).toBe('s-maxage=300, stale-while-revalidate=150');

    // HAFSQL served DGPO, so RPC was NOT called for it.
    const dgpoCalls = mockCall.mock.calls.filter(c => c[1] === 'get_dynamic_global_properties');
    expect(dgpoCalls).toHaveLength(0);
  });

  it('falls back to dhive RPC when the HAFSQL query throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExecuteQuery.mockRejectedValue(new Error('haf down'));
    wireHive();

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.globalProperties.source).toBe('hive-rpc');
    expect(json.data.globalProperties.vests_per_hive).toBe(1620); // shares / fund
    expect(json.data.globalProperties.total_vesting_fund_hive).toBe(180000000);
    const dgpoCalls = mockCall.mock.calls.filter(c => c[1] === 'get_dynamic_global_properties');
    expect(dgpoCalls).toHaveLength(1);
  });

  it('falls back to dhive RPC when the HAFSQL view returns no rows', async () => {
    mockExecuteQuery.mockResolvedValue({ rows: [], headers: [] });
    wireHive();

    const res = await GET();
    const json = await res.json();

    expect(json.data.globalProperties.source).toBe('hive-rpc');
  });

  it('requests the post reward fund specifically', async () => {
    mockExecuteQuery.mockResolvedValue({ rows: [HAF_ROW], headers: [] });
    wireHive();

    await GET();
    expect(mockCall).toHaveBeenCalledWith('condenser_api', 'get_reward_fund', ['post']);
  });

  it('returns 500 without cache headers when a required RPC fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExecuteQuery.mockResolvedValue({ rows: [HAF_ROW], headers: [] });
    wireHive({ reward: new Error('rpc down') });

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({ success: false, error: 'Failed to fetch chain globals' });
    expect(res.headers.get('CDN-Cache-Control')).toBeNull();
  });
});
