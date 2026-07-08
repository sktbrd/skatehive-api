import { NextRequest, NextResponse } from 'next/server';
import { HAFSQL_Database } from '@/lib/hafsql_database';
import { normalizePost } from '@/app/api/v2/feed/helpers';
import { dealiasSoftPosts } from '@/lib/soft-posts';
import { cacheHeaders } from '@/lib/cache-headers';

const hafDb = new HAFSQL_Database();

// Column list, children subquery and votes aggregation mirror fetchFeedData in
// ../../feed/route.ts so a single post is byte-for-byte shape-compatible with feed items.
const POST_QUERY = `
  SELECT
    c.body, c.author, c.permlink, c.parent_author, c.parent_permlink,
    c.created, c.last_edited, c.cashout_time, c.remaining_till_cashout, c.last_payout,
    c.tags, c.category, c.json_metadata AS post_json_metadata, c.root_author, c.root_permlink,
    c.pending_payout_value, c.author_rewards, c.author_rewards_in_hive, c.total_payout_value,
    c.curator_payout_value, c.beneficiary_payout_value, c.total_rshares, c.net_rshares, c.total_vote_weight,
    c.beneficiaries, c.max_accepted_payout, c.percent_hbd, c.allow_votes, c.allow_curation_rewards, c.deleted,
    (
      SELECT COUNT(*)
      FROM comments ch
      WHERE ch.parent_author = c.author
        AND ch.parent_permlink = c.permlink
        AND ch.deleted = false
    ) AS children,
    a.json_metadata AS user_json_metadata, a.reputation, a.followers, a.followings,
    COALESCE(
      json_agg(
        json_build_object(
          'id', v.id,
          'timestamp', v.timestamp,
          'voter', v.voter,
          'weight', v.weight,
          'rshares', v.rshares,
          'total_vote_weight', v.total_vote_weight,
          'pending_payout', v.pending_payout,
          'pending_payout_symbol', v.pending_payout_symbol
        )
      ) FILTER (WHERE v.id IS NOT NULL),
      '[]'
    ) AS votes
  FROM comments c
  LEFT JOIN accounts a ON c.author = a.name
  LEFT JOIN operation_effective_comment_vote_view v
    ON c.author = v.author
    AND c.permlink = v.permlink
  WHERE c.author = @author
    AND c.permlink = @permlink
    AND c.deleted = false
  GROUP BY
    c.body, c.author, c.permlink, c.parent_author, c.parent_permlink, c.created, c.last_edited, c.cashout_time,
    c.remaining_till_cashout, c.last_payout, c.tags, c.category, c.json_metadata, c.root_author, c.root_permlink,
    c.pending_payout_value, c.author_rewards, c.author_rewards_in_hive, c.total_payout_value, c.curator_payout_value,
    c.beneficiary_payout_value, c.total_rshares, c.net_rshares, c.total_vote_weight, c.beneficiaries, c.max_accepted_payout,
    c.percent_hbd, c.allow_votes, c.allow_curation_rewards, c.deleted, a.json_metadata, a.reputation, a.followers, a.followings
  LIMIT 1;
`;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ author: string; permlink: string }> }
) {
  const { author, permlink } = await params;

  try {
    const { rows } = await hafDb.executeQuery(POST_QUERY, [
      { name: 'author', value: author },
      { name: 'permlink', value: permlink },
    ]);

    if (!rows?.length) {
      return NextResponse.json(
        { success: false, error: 'Post not found' },
        { status: 404, headers: cacheHeaders(60, 30) }
      );
    }

    const normalized = normalizePost(rows[0], 'haf');
    const [post] = await dealiasSoftPosts([normalized]);

    return NextResponse.json(
      { success: true, data: post },
      { status: 200, headers: cacheHeaders(300, 150) }
    );
  } catch (error) {
    console.error(`Failed to fetch post ${author}/${permlink}:`, error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch post' },
      { status: 500 }
    );
  }
}
