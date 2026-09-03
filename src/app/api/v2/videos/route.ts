import { NextRequest, NextResponse } from 'next/server';
import { HAFSQL_Database } from '@/lib/hafsql_database';
import { extractVideosFromPost, VideoEntry } from '@/lib/video-extraction';
import { resolveThumbnails } from '@/lib/video-thumbnails';
import { buildVideoPostsQuery } from '@/lib/video-posts-query';
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
  author: string,
  limit: number,
  offset: number,
): Promise<any[]> {
  const { query, params } = buildVideoPostsQuery(community, parentPermlink, author, limit, offset);
  const result = await hafDb.executeQuery(query, params);

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
  author: string,
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
    const rows = await fetchVideoPostsBatch(community, parentPermlink, author, BATCH_SIZE, dbOffset);

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

  // Resolve thumbnails: metadata/body (already set) -> our cache -> Pinata -> transcoder
  const resolvedVideos = await resolveThumbnails(videos);

  return { videos: resolvedVideos, hasMore };
}

async function updateCacheInBackground(
  community: string,
  parentPermlink: string,
  author: string,
  targetCount: number,
  page: number,
  cacheKey: string,
) {
  if (activeUpdates.has(cacheKey)) return;
  activeUpdates.add(cacheKey);
  try {
    const { videos } = await fetchVideos(community, parentPermlink, author, targetCount, page);
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
  const author = (searchParams.get('author') || '').trim().toLowerCase();
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit')) || 20));

  try {
    cleanupCache();

    const cacheKey = `videos:${community}:${author}:${page}:${limit}`;
    const cached = cache.get(cacheKey);

    let videos: VideoEntry[];
    let hasMore: boolean;

    if (cached) {
      videos = cached.data;
      hasMore = videos.length >= limit;
      console.log(`[videos] cache hit: ${cacheKey}, ${videos.length} videos`);
    } else {
      console.log(`[videos] cache miss: ${cacheKey}`);
      const result = await fetchVideos(community, PARENT_PERMLINK, author, limit, page);
      videos = result.videos;
      hasMore = result.hasMore;
      cache.set(cacheKey, { data: videos, timestamp: Date.now() });
    }

    // Always refresh in background so next request is fresh
    setTimeout(() => updateCacheInBackground(community, PARENT_PERMLINK, author, limit, page, cacheKey), 0);

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
