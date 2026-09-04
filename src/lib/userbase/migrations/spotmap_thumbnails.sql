-- Spotmap images: admin-editable thumbnail override + a small (max-400px)
-- cached thumbnail, so the iOS widget stops decoding full-size source photos
-- (Google My Maps PNGs up to ~4MB, Hive JPEGs ~1MB) against its ~30MB
-- extension memory limit.
--
-- NOT applied by this agent. The CANONICAL copy of this migration lives in
-- skatehive3.0/sql/migrations/0033_spotmap_thumbnails.sql (Frontside adds it
-- there, same shape) — spotmap_spots itself is web-owned schema (see
-- 0022_spotmap_spots.sql), this file exists here only as the API-side record
-- of the same change, per the schema rule (userbase schema truth lives in
-- skatehive3.0/sql/migrations). Apply the web repo's 0033 migration to the
-- userbase project; do not apply this file separately or the two will race
-- each other with `add column if not exists`.
--
-- Neither the nightly Hive sync (lib/spotmap/syncHive.ts) nor the KML sync
-- (lib/spotmap/syncGoogleKml.ts) nor the mobile spot-create upsert ever
-- write these two columns — that's the whole point: an admin's override and
-- the derived small thumbnail survive every re-sync.

alter table public.spotmap_spots
  add column if not exists thumbnail_override text,
  add column if not exists thumbnail_small text;
