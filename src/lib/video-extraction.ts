export interface VideoEntry {
  videoUrl: string;
  thumbnailUrl: string | null;
  author: string;
  permlink: string;
  title: string;
  created: string;
  votes: number;
  payout: string;
  replies: number;
  tags: string[];
  active_votes: { voter: string; weight: number; rshares?: number }[];
}

interface ExtractedMedia {
  type: 'image' | 'video' | 'embed';
  url: string;
}

// ============================================================================
// IPFS / Pinata thumbnail lookup
// ============================================================================

/** Extract the CID from an IPFS gateway URL */
export function extractIPFSHash(url: string): string | null {
  const match = url.match(/\/ipfs\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// Long-lived cache for Pinata metadata (thumbnails rarely change)
const thumbnailCache = new Map<string, { url: string | null; timestamp: number }>();
const THUMBNAIL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch thumbnail URL from Pinata metadata for a single IPFS hash.
 * Uses PINATA_API_KEY + PINATA_SECRET_API_KEY (legacy API auth).
 */
async function fetchThumbnailFromPinata(hash: string): Promise<string | null> {
  const apiKey = process.env.PINATA_API_KEY;
  const apiSecret = process.env.PINATA_SECRET_API_KEY;
  if (!apiKey || !apiSecret) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`https://api.pinata.cloud/data/pinList?hashContains=${hash}&status=pinned`, {
      headers: {
        pinata_api_key: apiKey,
        pinata_secret_api_key: apiSecret,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;

    const data = await res.json();
    const file = data.rows?.find((f: any) => f.ipfs_pin_hash === hash);
    return file?.metadata?.keyvalues?.thumbnailUrl || null;
  } catch {
    return null;
  }
}

/**
 * Batch-resolve thumbnail URLs for a list of video entries.
 * Hits Pinata only for IPFS videos that don't already have a thumbnail.
 * Runs lookups concurrently (max 6 at a time) with caching.
 */
export async function enrichThumbnails(videos: VideoEntry[]): Promise<VideoEntry[]> {
  // Collect unique hashes that need lookup
  const hashToIndices = new Map<string, number[]>();

  videos.forEach((v, i) => {
    if (v.thumbnailUrl) return; // already has one from json_metadata/body
    const hash = extractIPFSHash(v.videoUrl);
    if (!hash) return;

    // Check cache first
    const cached = thumbnailCache.get(hash);
    if (cached && Date.now() - cached.timestamp < THUMBNAIL_CACHE_TTL) {
      videos[i] = { ...v, thumbnailUrl: cached.url };
      return;
    }

    const indices = hashToIndices.get(hash) || [];
    indices.push(i);
    hashToIndices.set(hash, indices);
  });

  if (hashToIndices.size === 0) return videos;

  // Fetch in batches of 6 to avoid overwhelming Pinata
  const hashes = Array.from(hashToIndices.keys());
  const BATCH = 6;

  for (let i = 0; i < hashes.length; i += BATCH) {
    const batch = hashes.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (hash) => {
        const url = await fetchThumbnailFromPinata(hash);
        thumbnailCache.set(hash, { url, timestamp: Date.now() });
        return { hash, url };
      })
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { hash, url } = result.value;
      const indices = hashToIndices.get(hash) || [];
      for (const idx of indices) {
        videos[idx] = { ...videos[idx], thumbnailUrl: url };
      }
    }
  }

  return videos;
}

/**
 * CID redirect map: VP9/non-H.264 videos that have been re-transcoded to H.264.
 * Maps old IPFS CID → new H.264 CID so mobile (iOS AVPlayer) can play them.
 * The original CID stays on the blockchain post; the API swaps it transparently.
 */
const CID_REDIRECTS: Record<string, string> = {
  // tallessilva VP9 → H.264
  'bafybeidclwvvkpva4ky5wsres32ucdgz7gq4p2psjjnqym3roc7lyf3io4': 'bafybeidzd5pjifjoxvfj26q37ra3qv573pof44lvfs32jo2jk3nom2nhsy',
  'bafybeihfb32uzuqljdtxhdmb7nhor4tcvnbmzwknvz7ylds6bvnafc6qzq': 'bafybeibs2zetcq7hf3euwbp5jgfmd4k4vzvenbhl6ueqk4u5mgai3cu5ba',
  'bafybeihb4w3jpc3nbkjbnpbiumcuraus4lguraistvddmlcqxmyv7iv4oi': 'bafybeifmiau56f4ltomu3ya7q64xfmtgq2zfj56zfivdpa6fyibci3pzbm',
  // navaskt VP9 → H.264
  'bafybeicd73dc3aagdvwcebzsk2ed5istkfe4fqbwylhhd3y7hur36upldm': 'bafybeidhkk7f3j7tzwh2t5tc4ir7bivstn5bemfyfhjjteaaajne5viboa',
  // liskafoundations VP9 → H.264
  'bafybeig555dawnl5fabcfsxzw2z7tilimhlyit4fealjlfpyd7lasa6mnm': 'bafybeidhjmvyqs4xetkuabncw73m6xwxoqaarm3xpv4blxtzcyzdt4lhne',
  // bafybeifoekk7n6wal7wqg5ow3yqvk4vy7vj3p6rwqufqj5rxnqkqhqabnq — corrupt, cannot transcode
};

/** Replace known non-H.264 CIDs in a video URL with their transcoded versions. */
function applyVideoRedirects(url: string): string {
  for (const [oldCid, newCid] of Object.entries(CID_REDIRECTS)) {
    if (url.includes(oldCid)) {
      return url.replace(oldCid, newCid);
    }
  }
  return url;
}

/**
 * Server-side port of extractMediaFromBody from the mobile app (apps/mobileapp/lib/utils.ts).
 * Extracts video and image URLs from a Hive post body.
 */
function extractMediaFromBody(body: string): ExtractedMedia[] {
  const media: ExtractedMedia[] = [];
  const processedUrls = new Set<string>();

  // Extract images (needed for thumbnail fallback)
  const imageMatches = body.match(/!\[.*?\]\((.*?)\)/g);
  if (imageMatches) {
    imageMatches.forEach(match => {
      const url = match.match(/\((.*?)\)/)?.[1];
      if (url && !processedUrls.has(url)) {
        media.push({ type: 'image', url });
        processedUrls.add(url);
      }
    });
  }

  // Extract videos from iframes (multiline)
  const iframeMatches = body.match(/<iframe[\s\S]*?src="(.*?)"[\s\S]*?<\/iframe>/gi);
  if (iframeMatches) {
    iframeMatches.forEach(match => {
      const url = match.match(/src="(.*?)"/)?.[1];
      if (url && !processedUrls.has(url)) {
        const isDirectVideo = url.includes('ipfs') ||
          url.includes('.mp4') ||
          url.includes('.webm') ||
          url.includes('.m3u8') ||
          url.includes('.mov');

        if (isDirectVideo) {
          media.push({ type: 'video', url });
        } else {
          let embedUrl = url;
          if (url.includes('youtube.com') || url.includes('youtu.be')) {
            const videoIdMatch = url.match(/(?:embed\/|watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
            if (videoIdMatch) {
              embedUrl = `https://www.youtube-nocookie.com/embed/${videoIdMatch[1]}`;
            }
          } else if (url.includes('odysee.com')) {
            embedUrl = url.replace('/watch?v=', '/$/embed/');
          }
          media.push({ type: 'embed', url: embedUrl });
        }
        processedUrls.add(url);
      }
    });
  }

  // Only extract plain YouTube/Odysee URLs if no IPFS video iframe found
  const hasIpfsVideo = media.some(m => m.type === 'video' && m.url.includes('ipfs'));

  if (!hasIpfsVideo) {
    const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]+)/g;
    let youtubeMatch;
    while ((youtubeMatch = youtubeRegex.exec(body)) !== null) {
      const videoId = youtubeMatch[1];
      const embedUrl = `https://www.youtube-nocookie.com/embed/${videoId}`;
      if (!processedUrls.has(embedUrl) && !processedUrls.has(youtubeMatch[0])) {
        media.push({ type: 'embed', url: embedUrl });
        processedUrls.add(embedUrl);
        processedUrls.add(youtubeMatch[0]);
      }
    }

    const odyseeRegex = /(?:https?:\/\/)?(?:www\.)?odysee\.com\/(@[^\/]+\/[^:]+:[a-zA-Z0-9]+)/g;
    let odyseeMatch;
    while ((odyseeMatch = odyseeRegex.exec(body)) !== null) {
      const videoPath = odyseeMatch[1];
      const embedUrl = `https://odysee.com/$/embed/${videoPath}`;
      if (!processedUrls.has(embedUrl) && !processedUrls.has(odyseeMatch[0])) {
        media.push({ type: 'embed', url: embedUrl });
        processedUrls.add(embedUrl);
        processedUrls.add(odyseeMatch[0]);
      }
    }
  }

  return media;
}

/**
 * Extract a thumbnail URL from post metadata and body.
 */
function extractThumbnail(jsonMetadata: any, bodyMedia: ExtractedMedia[]): string | null {
  // Try json_metadata.image[0] first
  try {
    const parsed = typeof jsonMetadata === 'string' ? JSON.parse(jsonMetadata) : jsonMetadata;
    if (parsed?.image?.[0]) return parsed.image[0];
  } catch {}

  // Fallback: first image from body
  const firstImage = bodyMedia.find(m => m.type === 'image');
  return firstImage?.url || null;
}

/**
 * Extract video entries from a raw HAFSQL post row.
 * Returns one VideoEntry per video found in the post (a post with 2 videos = 2 entries).
 */
export function extractVideosFromPost(post: any): VideoEntry[] {
  const body: string = post.body || '';
  const media = extractMediaFromBody(body);
  const videoMedia = media.filter(m => m.type === 'video');

  // No videos in this post
  if (videoMedia.length === 0) return [];

  let metadata: any = {};
  try {
    metadata = typeof post.post_json_metadata === 'string'
      ? JSON.parse(post.post_json_metadata)
      : post.post_json_metadata;
  } catch {
    metadata = {};
  }

  const thumbnailUrl = extractThumbnail(metadata, media);

  // Normalize votes to slim { voter, weight } array
  let activeVotes: { voter: string; weight: number; rshares?: number }[] = [];
  if (Array.isArray(post.votes)) {
    activeVotes = post.votes
      .filter((v: any) => v && v.voter)
      .map((v: any) => ({ voter: v.voter, weight: Number(v.weight), rshares: Number(v.rshares || 0) }));
  }

  const netVotes = activeVotes.filter(v => v.weight > 0).length;
  const payout = post.pending_payout_value && parseFloat(post.pending_payout_value) > 0
    ? post.pending_payout_value
    : post.total_payout_value || '0';

  return videoMedia.map(video => ({
    videoUrl: applyVideoRedirects(video.url),
    thumbnailUrl,
    author: post.author,
    permlink: post.permlink,
    title: post.title || '',
    created: post.created ? new Date(post.created).toISOString() : '',
    votes: netVotes,
    payout: String(payout),
    replies: Number(post.children || 0),
    tags: metadata?.tags || [],
    active_votes: activeVotes,
  }));
}
