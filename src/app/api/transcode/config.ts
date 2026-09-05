// Shared configuration for transcode services.
// All servers run the same SkateHive video-transcoder codebase.
// Priority order reflects the current production routing.
// IMPORTANT: video blobs should upload directly to transcoder hosts. Do not route
// normal uploads through Vercel/API functions; serverless body limits cause 413
// FUNCTION_PAYLOAD_TOO_LARGE before the transcoder sees the file.
export const TRANSCODE_SERVICES = [
  {
    priority: 1,
    name: 'Mac Mini M4 (Primary)',
    healthUrl: 'https://minivlad.tail83ea3e.ts.net/video/healthz',
    transcodeUrl: 'https://minivlad.tail83ea3e.ts.net/video/transcode'
  },
  {
    priority: 2,
    name: 'Oracle (Secondary)',
    healthUrl: 'https://transcode.skatehive.app/healthz',
    transcodeUrl: 'https://transcode.skatehive.app/transcode'
  }
];

// F3 (server-side video thumbnails): the transcoder's POST /thumbnail
// endpoint on the primary (Mac Mini) service, guarded by a shared secret
// header. Safe to default to production like TRANSCODE_SERVICES above —
// this endpoint is meant to always be live.
export const THUMBNAIL_SERVICE_URL =
  process.env.THUMBNAIL_SERVICE_URL || 'https://minivlad.tail83ea3e.ts.net/video/thumbnail';

// Spotmap admin images (thumbnail_small for spot photos hosted off the Hive
// CDN): the transcoder's POST /image-thumbnail endpoint, guarded by the SAME
// shared secret as the video-thumbnail work above (THUMBNAIL_SHARED_SECRET,
// one constant, both endpoints).
//
// No default URL, deliberately: unlike THUMBNAIL_SERVICE_URL and
// TRANSCODE_SERVICES (safe to point at production by default), generation
// should stay OFF until someone explicitly wires it up. An unset
// IMAGE_THUMBNAIL_SERVICE_URL means resolveSmallThumbnail's transcoder path
// silently no-ops (falls through to "not resolved yet") rather than firing
// requests at a guessed host.
export const IMAGE_THUMBNAIL_SERVICE_URL = process.env.IMAGE_THUMBNAIL_SERVICE_URL || '';

// Shared by both endpoints above. Fails closed either way: an empty secret
// never matches what a caller sends, since both call sites also require
// THUMBNAIL_SHARED_SECRET itself to be truthy (see video-thumbnails.ts,
// spotmap-thumbnails.ts, and the transcoder's own check).
export const THUMBNAIL_SHARED_SECRET = process.env.THUMBNAIL_SHARED_SECRET || '';

export interface ServiceConfig {
  priority: number;
  name: string;
  healthUrl: string;
  transcodeUrl: string;
}

export interface ServiceStatus extends ServiceConfig {
  isHealthy: boolean;
  responseTime?: number;
  capacity?: {
    active: number;
    max: number;
    available: number;
  };
  error?: string;
  lastChecked: string;
}
