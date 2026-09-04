/**
 * Spotmap images backfill: walk every spotmap_spots row with a thumbnail
 * (or thumbnail_override) but no thumbnail_small yet, and resolve one
 * (Hive CDN URL build, or the transcoder for everything else).
 *
 * Sequential and synchronous on purpose — this is a one-off backfill run
 * off-peak, not a hot request path, and the transcoder's image-thumbnail
 * job only accepts one request at a time anyway.
 *
 * NOT run by this session. Requires the spotmap_thumbnails migration
 * (canonical copy: skatehive3.0/sql/migrations/0033_spotmap_thumbnails.sql)
 * to already be applied, and IMAGE_THUMBNAIL_SERVICE_URL +
 * THUMBNAIL_SHARED_SECRET to be set the same as the transcoder.
 *
 * Usage:
 *   npm run backfill:spot-thumbnails                 # run the backfill
 *   npm run backfill:spot-thumbnails -- --check       # validate env + count work only
 *   npm run backfill:spot-thumbnails -- --limit 50    # cap how many spots to process
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabaseAdmin } from '../src/app/utils/supabase/supabaseClient';
import { backfillSpotThumbnail } from '../src/lib/spotmap-thumbnails';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(repoRoot, '.env.local') });
dotenv.config({ path: path.join(repoRoot, '.env') });

const CHECK_ONLY = process.argv.includes('--check');
const limitArgIndex = process.argv.indexOf('--limit');
const SPOT_LIMIT = limitArgIndex >= 0 ? Number(process.argv[limitArgIndex + 1]) || Infinity : Infinity;

const ts = () => new Date().toISOString();
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);

const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'IMAGE_THUMBNAIL_SERVICE_URL',
  'THUMBNAIL_SHARED_SECRET',
];

async function collectSpotsMissingSmallThumbnail(limit: number) {
  if (!supabaseAdmin) throw new Error('Supabase not configured');
  const { data, error } = await supabaseAdmin
    .from('spotmap_spots')
    .select('id, thumbnail, thumbnail_override, thumbnail_small')
    .is('thumbnail_small', null)
    .not('thumbnail', 'is', null)
    .limit(limit === Infinity ? 10000 : limit);
  if (error) throw new Error(`Query failed: ${error.message}`);
  return data || [];
}

async function main() {
  const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missingEnv.length > 0) {
    console.error(`Missing required env vars: ${missingEnv.join(', ')}`);
    process.exit(1);
  }
  if (!supabaseAdmin) {
    console.error('Supabase not configured');
    process.exit(1);
  }

  const spots = await collectSpotsMissingSmallThumbnail(SPOT_LIMIT);
  log(`Found ${spots.length} spot(s) missing thumbnail_small.`);

  if (CHECK_ONLY) {
    log('--check: no writes made.');
    process.exit(0);
  }

  let ready = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i];
    try {
      const result = await backfillSpotThumbnail(spot);
      if (result.status === 'ready') ready++;
      else if (result.status === 'failed') failed++;
      else skipped++;
      log(`[${i + 1}/${spots.length}] ${spot.id} -> ${result.status}`);
    } catch (err: any) {
      failed++;
      log(`[${i + 1}/${spots.length}] ${spot.id} -> error: ${err?.message || err}`);
    }
  }

  log(`Done. ready=${ready} failed=${failed} skipped=${skipped} of ${spots.length}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
