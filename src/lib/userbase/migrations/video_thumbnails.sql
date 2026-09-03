-- Per-CID thumbnail cache for /api/v2/videos (F3: server-side thumbnails).
--
-- api-only data (no web app usage), so — per the schema rule (userbase schema
-- truth lives in skatehive3.0/sql/migrations) — this is the CANONICAL source:
-- it lives here because it has no web counterpart, against the same userbase
-- Supabase project as userbase_users / userbase_sessions.
--
-- NOT applied automatically. Run this by hand against the userbase project
-- before deploying the code that reads/writes this table.
--
-- Lifecycle: a row starts 'pending' when we queue a transcoder thumbnail job
-- for a CID with no metadata/body/Pinata thumbnail, and becomes 'ready' (with
-- thumbnail_url set) or 'failed' (with last_error set) when that job's
-- fire-and-forget response comes back. `attempts` caps retries (max 3, with
-- backoff between them) so an unpinned/corrupt CID doesn't get hammered on
-- every video-list request. `source` records which lookup path produced a
-- 'ready' row (currently only 'transcoder' — metadata/body/Pinata hits are
-- resolved without ever writing a row here).

create table if not exists public.video_thumbnails (
  cid           text primary key,
  thumbnail_url text,
  status        text not null default 'pending'
                  check (status in ('pending', 'ready', 'failed')),
  attempts      integer not null default 0,
  last_error    text,
  source        text,
  updated_at    timestamptz not null default now()
);

-- The backfill script and the lazy resolver both need "which CIDs still need
-- work" fast.
create index if not exists idx_video_thumbnails_status
  on public.video_thumbnails (status);
