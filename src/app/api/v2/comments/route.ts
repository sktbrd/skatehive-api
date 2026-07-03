import { NextRequest, NextResponse } from 'next/server';
import { HAFSQL_Database } from '@/lib/hafsql_database';

const db = new HAFSQL_Database();

export async function GET(request: NextRequest) {
  try {
    // Get query parameters from URL
    const { searchParams } = new URL(request.url);
    const parent_author = searchParams.get('pa');
    const parent_permlink = searchParams.get('pp');

    // Validate required parameters
    if (!parent_author || !parent_permlink) {
      return NextResponse.json(
        {
          success: false,
          error: 'Missing required parameters: parent_author and parent_permlink'
        },
        { status: 400 }
      );
    }

    // Get comments with their votes
    const {rows, headers} = await db.executeQuery(`
      SELECT 
        c.title, 
        c.body, 
        c.author, 
        c.permlink, 
        c.parent_author, 
        c.parent_permlink, 
        c.created, 
        c.last_edited, 
        c.cashout_time, 
        c.remaining_till_cashout, 
        c.last_payout, 
        c.tags, 
        c.category, 
        c.json_metadata, 
        c.root_author, 
        c.root_permlink, 
        c.pending_payout_value, 
        c.author_rewards, 
        c.author_rewards_in_hive, 
        c.total_payout_value, 
        c.curator_payout_value, 
        c.beneficiary_payout_value, 
        c.total_rshares, 
        c.net_rshares, 
        c.total_vote_weight, 
        c.beneficiaries, 
        c.max_accepted_payout, 
        c.percent_hbd, 
        c.allow_votes, 
        c.allow_curation_rewards, 
        a.reputation,
        COALESCE(
          json_agg(
            json_build_object(
              'voter', v.voter,
              'timestamp', v.timestamp,
              'vote_percent', ROUND((v.weight::numeric / 100000000)::numeric, 0)
            )
            ORDER BY v.timestamp DESC
          ) FILTER (WHERE v.author IS NOT NULL AND v.permlink IS NOT NULL), 
          '[]'
        ) as votes
      FROM comments c
      LEFT JOIN accounts a ON c.author = a.name
      LEFT JOIN operation_effective_comment_vote_view v 
        ON c.author = v.author 
        AND c.permlink = v.permlink
      WHERE c.parent_author = @pa
      AND c.parent_permlink = @pp
      AND c.deleted = false
      GROUP BY
        c.id,
        c.title,
        c.body,
        c.author,
        c.permlink,
        c.parent_author,
        c.parent_permlink,
        c.created,
        c.json_metadata,
        c.pending_payout_value,
        a.reputation
      ORDER BY c.created DESC
    `, [
      { name: 'pa', value: parent_author },
      { name: 'pp', value: parent_permlink },
    ]);

    if (!rows || rows.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'No comments found'
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: rows,
        headers: headers
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Comments fetch error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch comments'
      },
      { status: 500 }
    );
  }
}