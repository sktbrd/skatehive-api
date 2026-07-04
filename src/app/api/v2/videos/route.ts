import { NextRequest, NextResponse } from 'next/server';
import { HAFSQL_Database } from '@/lib/hafsql_database';
import { extractVideosFromPost, enrichThumbnails, VideoEntry } from '@/lib/video-extraction';
import { normalizeHafVotes } from '@/app/api/v2/feed/helpers';

const hafDb = new HAFSQL_Database();

// Short TTL so new posts appear quickly (60s vs feed's 5min)
const cache: Map<string, { data: VideoEntry[]; timestamp: number }> = new Map();
const activeUpdates = new Set<string>();
const CACHE_TTL = 60_000; // 1 minute

function cleanupCache() {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      cache.delete(key);
    }
  }
}

const PARENT_PERMLINK = process.env.PARENT_PERMLINK || '';

// Fetch posts from HAFSQL with a lean SELECT (no user metadata, no body-heavy fields we don't need)
async function fetchVideoPostsBatch(
  community: string,
  parentPermlink: string,
  limit: number,
  offset: number,
): Promise<any[]> {
  const tagFilter = `{"tags": ["${community}"]}`;

  const query = `
    SELECT
      c.body, c.author, c.permlink, c.title,
      c.created, c.json_metadata AS post_json_metadata,
      c.pending_payout_value, c.total_payout_value,
      (
        SELECT COUNT(*)
        FROM comments ch
        WHERE ch.parent_author = c.author
          AND ch.parent_permlink = c.permlink
          AND ch.deleted = false
      ) AS children,
      COALESCE(
        json_agg(
          json_build_object(
            'voter', v.voter,
            'weight', v.weight,
            'rshares', v.rshares
          )
        ) FILTER (WHERE v.id IS NOT NULL),
        '[]'
      ) AS votes
    FROM comments c
    LEFT JOIN operation_effective_comment_vote_view v
      ON c.author = v.author
      AND c.permlink = v.permlink
    WHERE
      (
        (
          c.parent_author = 'peak.snaps'
          AND c.parent_permlink SIMILAR TO 'snap-container-%'
          AND c.json_metadata @> @tag_filter
        )
        OR c.parent_permlink = @parent_permlink
      )
      AND c.deleted = false
    GROUP BY
      c.body, c.author, c.permlink, c.title, c.created,
      c.json_metadata, c.pending_payout_value, c.total_payout_value
    ORDER BY c.created DESC
    LIMIT @limit
    OFFSET @offset;
  `;

  const result = await hafDb.executeQuery(query, [
    { name: 'tag_filter', value: tagFilter },
    { name: 'parent_permlink', value: parentPermlink },
    { name: 'limit', value: limit },
    { name: 'offset', value: offset },
  ]);

  // Normalize votes from HAFSQL json_agg
  return result.rows.map(row => ({
    ...row,
    votes: normalizeHafVotes(row.votes),
  }));
}

/**
 * Fetch enough posts to fill the requested video count.
 * Not every post has a video, so we overfetch and iterate.
 */
async function fetchVideos(
  community: string,
  parentPermlink: string,
  targetCount: number,
  page: number,
): Promise<{ videos: VideoEntry[]; hasMore: boolean }> {
  const videos: VideoEntry[] = [];
  const BATCH_SIZE = targetCount * 3; // overfetch ratio
  const MAX_ITERATIONS = 4; // safety cap
  const startOffset = (page - 1) * targetCount;

  // We need to skip `startOffset` worth of video entries, then collect `targetCount`
  let dbOffset = 0;
  let skippedVideos = 0;
  let iterations = 0;

  while (videos.length < targetCount && iterations < MAX_ITERATIONS) {
    iterations++;
    const rows = await fetchVideoPostsBatch(community, parentPermlink, BATCH_SIZE, dbOffset);

    if (rows.length === 0) break; // no more posts

    for (const row of rows) {
      const entries = extractVideosFromPost(row);
      for (const entry of entries) {
        if (skippedVideos < startOffset) {
          skippedVideos++;
          continue;
        }
        videos.push(entry);
        if (videos.length >= targetCount) break;
      }
      if (videos.length >= targetCount) break;
    }

    dbOffset += BATCH_SIZE;

    // If this batch was full but we still need more, keep going
    if (rows.length < BATCH_SIZE) break;
  }

  // Check if there are more videos by seeing if we exhausted the batch
  const hasMore = videos.length >= targetCount;

  // Enrich with Pinata IPFS thumbnails for videos missing one
  const enrichedVideos = await enrichThumbnails(videos);

  return { videos: enrichedVideos, hasMore };
}

async function updateCacheInBackground(
  community: string,
  parentPermlink: string,
  targetCount: number,
  page: number,
  cacheKey: string,
) {
  if (activeUpdates.has(cacheKey)) return;
  activeUpdates.add(cacheKey);
  try {
    const { videos } = await fetchVideos(community, parentPermlink, targetCount, page);
    cache.set(cacheKey, { data: videos, timestamp: Date.now() });
  } catch (error) {
    console.error('Background video cache update failed:', error);
  } finally {
    activeUpdates.delete(cacheKey);
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const community = searchParams.get('community_code') || process.env.MY_COMMUNITY_CATEGORY || 'hive-173115';
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit')) || 20));

  try {
    cleanupCache();

    const cacheKey = `videos:${community}:${page}:${limit}`;
    const cached = cache.get(cacheKey);

    let videos: VideoEntry[];
    let hasMore: boolean;

    if (cached) {
      videos = cached.data;
      hasMore = videos.length >= limit;
      console.log(`[videos] cache hit: ${cacheKey}, ${videos.length} videos`);
    } else {
      console.log(`[videos] cache miss: ${cacheKey}`);
      const result = await fetchVideos(community, PARENT_PERMLINK, limit, page);
      videos = result.videos;
      hasMore = result.hasMore;
      cache.set(cacheKey, { data: videos, timestamp: Date.now() });
    }

    // Always refresh in background so next request is fresh
    setTimeout(() => updateCacheInBackground(community, PARENT_PERMLINK, limit, page, cacheKey), 0);

    return NextResponse.json({
      success: true,
      data: videos,
      pagination: {
        currentPage: page,
        limit,
        hasNextPage: hasMore,
        nextPage: hasMore ? page + 1 : null,
      },
    }, {
      status: 200,
      headers: {
        // Short edge cache: 60s serve, 30s stale-while-revalidate
        'Cache-Control': 's-maxage=60, stale-while-revalidate=30',
      },
    });

  } catch (error) {
    console.error('[videos] Failed to fetch:', error);
    return NextResponse.json({
      success: false,
      data: [],
      pagination: {
        currentPage: page,
        limit,
        hasNextPage: false,
        nextPage: null,
      },
    }, { status: 500 });
  }
}
