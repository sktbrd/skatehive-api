import { NextRequest, NextResponse } from 'next/server';
import { Notifications } from '@hiveio/dhive';
import { HiveClient } from '@/lib/hive-client';
import { cacheHeaders } from '@/lib/cache-headers';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100; // bridge.account_notifications caps at 100
const EPOCH = '1970-01-01T00:00:00Z';
const MAX_HISTORY_LOOPS = 5;

type NotificationWithReadStatus = Notifications & { isRead: boolean };

/**
 * Date of the user's most recent `notify` (setLastRead) custom_json, used to
 * derive read status. Mirrors the mobile app's findLastNotificationsReset:
 * scans account history in pages of 1000 custom_json ops, walking back up to
 * MAX_HISTORY_LOOPS pages. Defaults to the epoch (everything unread) if none
 * is found or the scan fails.
 */
async function getLastReadDate(username: string, start = -1, loop = 0): Promise<string> {
  if (loop >= MAX_HISTORY_LOOPS) return EPOCH;

  try {
    const { history } = await HiveClient.call('account_history_api', 'get_account_history', {
      account: username,
      start,
      limit: 1000,
      include_reversible: true,
      operation_filter_low: 262144, // custom_json
    });

    if (!history || history.length === 0) return EPOCH;

    for (const item of [...history].reverse()) {
      if (item[1].op.value.id === 'notify') {
        const json = JSON.parse(item[1].op.value.json);
        return json[1].date;
      }
    }

    return getLastReadDate(username, start - 1000, loop + 1);
  } catch {
    return EPOCH;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const { username } = await params;
  const { searchParams } = new URL(request.url);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(searchParams.get('limit')) || DEFAULT_LIMIT));
  const lastId = Number(searchParams.get('last_id')) || undefined;

  try {
    const bridgeParams: { account: string; limit: number; last_id?: number } = { account: username, limit };
    if (lastId) bridgeParams.last_id = lastId;

    const notifications: Notifications[] = await HiveClient.call(
      'bridge',
      'account_notifications',
      bridgeParams
    );
    const list = Array.isArray(notifications) ? notifications : [];

    const lastRead = await getLastReadDate(username);
    const lastReadTime = new Date(lastRead).getTime();
    const withReadStatus: NotificationWithReadStatus[] = list.map(n => ({
      ...n,
      isRead: new Date(n.date).getTime() <= lastReadTime,
    }));
    const unread = withReadStatus.filter(n => !n.isRead).length;

    return NextResponse.json(
      { success: true, data: { notifications: withReadStatus, lastRead, unread } },
      { status: 200, headers: cacheHeaders(30, 15) }
    );
  } catch (error) {
    console.error(`Failed to fetch notifications for ${username}:`, error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch notifications' },
      { status: 500 }
    );
  }
}
