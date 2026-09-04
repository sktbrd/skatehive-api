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

// Spotmap admin images (thumbnail_small for spot photos hosted off the Hive
// CDN): the transcoder's POST /image-thumbnail endpoint, guarded by the same
// shared secret as the video-thumbnail work (THUMBNAIL_SHARED_SECRET) — if
// feat/video-thumbnails adds this same constant first, reconcile rather than
// duplicating the env var.
export const IMAGE_THUMBNAIL_SERVICE_URL =
  process.env.IMAGE_THUMBNAIL_SERVICE_URL || 'https://minivlad.tail83ea3e.ts.net/video/image-thumbnail';
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
