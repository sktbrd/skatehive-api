/**
 * F3 backfill: walk every video post in HAFSQL, and for every distinct CID
 * that has no thumbnail from metadata/body, resolve one (DB cache -> Pinata
 * -> transcoder) and persist it to video_thumbnails.
 *
 * Sequential and synchronous on purpose — this is a one-off backfill run off
 * -peak on the Mac Mini, not a hot request path; the transcoder itself only
 * accepts one thumbnail job at a time anyway. At the plan's estimate (~547
 * CIDs actually missing a thumbnail, ~5-10s each) that's roughly 1-1.5h;
 * running against all ~2573 distinct video CIDs is ~4-7h.
 *
 * NOT run by this session. Requires the video_thumbnails migration
 * (src/lib/userbase/migrations/video_thumbnails.sql) to already be applied,
 * and THUMBNAIL_SERVICE_URL + THUMBNAIL_SHARED_SECRET to be set the same as
 * the transcoder.
 *
 * Usage:
 *   npm run backfill:thumbnails              # run the backfill
 *   npm run backfill:thumbnails -- --check   # validate env + count work only
 *   npm run backfill:thumbnails -- --limit 50 # cap how many CIDs to process
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { HAFSQL_Database } from '../src/lib/hafsql_database';
import { extractVideosFromPost } from '../src/lib/video-extraction';
import { buildVideoPostsQuery } from '../src/lib/video-posts-query';
import { extractIPFSHash } from '../src/lib/video-extraction';
import { backfillThumbnail } from '../src/lib/video-thumbnails';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(repoRoot, '.env.local') });
dotenv.config({ path: path.join(repoRoot, '.env') });

const CHECK_ONLY = process.argv.includes('--check');
const limitArgIndex = process.argv.indexOf('--limit');
const CID_LIMIT = limitArgIndex >= 0 ? Number(process.argv[limitArgIndex + 1]) || Infinity : Infinity;

const ts = () => new Date().toISOString();
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);

const REQUIRED_ENV = [
  'HAFSQL_SERVER',
  'HAFSQL_DATABASE',
  'HAFSQL_USER',
  'HAFSQL_PWD',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'THUMBNAIL_SERVICE_URL',
  'THUMBNAIL_SHARED_SECRET',
];

const COMMUNITY = process.env.MY_COMMUNITY_CATEGORY || 'hive-173115';
const PARENT_PERMLINK = process.env.PARENT_PERMLINK || '';
const PAGE_SIZE = 200;

async function collectCidsMissingThumbnails(hafDb: HAFSQL_Database): Promise<string[]> {
  const cids = new Set<string>();
  let offset = 0;
  let totalPosts = 0;

  for (;;) {
    const { query, params } = buildVideoPostsQuery(COMMUNITY, PARENT_PERMLINK, '', PAGE_SIZE, offset);
    const result = await hafDb.executeQuery(query, params);
    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      totalPosts++;
      const entries = extractVideosFromPost(row);
      for (const entry of entries) {
        if (entry.thumbnailUrl) continue; // metadata/body already covers it
        const cid = extractIPFSHash(entry.videoUrl);
        if (cid) cids.add(cid);
      }
    }

    offset += PAGE_SIZE;
    if (result.rows.length < PAGE_SIZE) break;
  }

  log(`Scanned ${totalPosts} video posts, ${cids.size} distinct CIDs missing a metadata/body thumbnail.`);
  return Array.from(cids);
}

async function main() {
  const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missingEnv.length > 0) {
    console.error(`Missing required env vars: ${missingEnv.join(', ')}`);
    process.exit(1);
  }

  const hafDb = new HAFSQL_Database();
  const cids = await collectCidsMissingThumbnails(hafDb);
  const toProcess = cids.slice(0, CID_LIMIT);

  if (CHECK_ONLY) {
    log(`--check: would process ${toProcess.length} of ${cids.length} CIDs. No writes made.`);
    process.exit(0);
  }

  let ready = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const cid = toProcess[i];
    try {
      const result = await backfillThumbnail(cid);
      if (result.status === 'ready') ready++;
      else if (result.status === 'failed') failed++;
      else skipped++;
      log(`[${i + 1}/${toProcess.length}] ${cid} -> ${result.status}`);
    } catch (err: any) {
      failed++;
      log(`[${i + 1}/${toProcess.length}] ${cid} -> error: ${err?.message || err}`);
    }
  }

  log(`Done. ready=${ready} failed=${failed} skipped=${skipped} of ${toProcess.length}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
