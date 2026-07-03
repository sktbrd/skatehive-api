import { NextResponse } from 'next/server';
import { HAFSQL_Database } from '@/lib/hafsql_database';
import { HiveClient } from '@/lib/hive-client';
import { cacheHeaders } from '@/lib/cache-headers';

const db = new HAFSQL_Database();

// HAFSQL stores these as raw integers: HIVE at 3 decimals, VESTS at 6.
const HIVE_PRECISION = 1000;
const VESTS_PRECISION = 1_000_000;

interface GlobalProperties {
  total_vesting_fund_hive: number;
  total_vesting_shares: number;
  vests_per_hive: number; // VESTS per 1 HIVE — HP = vests / vests_per_hive
  head_block_number: number;
  source: 'hafsql' | 'hive-rpc';
}

/**
 * Latest dynamic global properties from HAFSQL (the `dynamic_global_properties`
 * view is per-block history, so take the newest row). Returns null if the view
 * has no rows so the caller can fall back to RPC.
 */
async function getGlobalPropertiesFromHafsql(): Promise<GlobalProperties | null> {
  const { rows } = await db.executeQuery(
    `SELECT total_vesting_fund_hive, total_vesting_shares, vests_per_hive, block_num
     FROM dynamic_global_properties
     ORDER BY block_num DESC
     LIMIT 1`
  );
  if (!rows?.length) return null;

  const r = rows[0];
  return {
    total_vesting_fund_hive: Number(r.total_vesting_fund_hive) / HIVE_PRECISION,
    total_vesting_shares: Number(r.total_vesting_shares) / VESTS_PRECISION,
    vests_per_hive: Number(r.vests_per_hive),
    head_block_number: Number(r.block_num),
    source: 'hafsql',
  };
}

/** dhive fallback — RPC returns asset strings ("164699.431 HIVE") that we parse. */
async function getGlobalPropertiesFromRpc(): Promise<GlobalProperties> {
  const dgpo = await HiveClient.call('condenser_api', 'get_dynamic_global_properties', []);
  const fund = parseFloat(dgpo.total_vesting_fund_hive);
  const shares = parseFloat(dgpo.total_vesting_shares);
  return {
    total_vesting_fund_hive: fund,
    total_vesting_shares: shares,
    vests_per_hive: shares / fund,
    head_block_number: Number(dgpo.head_block_number),
    source: 'hive-rpc',
  };
}

/** HAFSQL first, dhive RPC as fallback. */
async function getGlobalProperties(): Promise<GlobalProperties> {
  try {
    const haf = await getGlobalPropertiesFromHafsql();
    if (haf) return haf;
  } catch (error) {
    console.warn('HAFSQL dynamic_global_properties failed; falling back to RPC:', error);
  }
  return getGlobalPropertiesFromRpc();
}

/**
 * Chain-wide constants for HP and vote-value math. globalProperties (the
 * VESTS<->HP ratio) is served HAFSQL-first with a dhive fallback; the reward
 * pool and median price are dhive-only (not exposed by HAFSQL). Identical for
 * every user and slow-moving, so one cached read serves the whole app.
 */
export async function GET() {
  try {
    const [globalProperties, rewardFund, medianPrice] = await Promise.all([
      getGlobalProperties(),
      HiveClient.call('condenser_api', 'get_reward_fund', ['post']),
      HiveClient.call('condenser_api', 'get_current_median_history_price', []),
    ]);

    return NextResponse.json(
      { success: true, data: { globalProperties, rewardFund, medianPrice } },
      { status: 200, headers: cacheHeaders(300, 150) }
    );
  } catch (error) {
    console.error('Failed to fetch chain globals:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch chain globals' },
      { status: 500 }
    );
  }
}
