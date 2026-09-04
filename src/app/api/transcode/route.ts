import { NextRequest, NextResponse } from 'next/server';
import { TRANSCODE_SERVICES } from './config';

// Cache for health check results to avoid constant polling
let healthCache: { [key: string]: { isHealthy: boolean; lastCheck: number } } = {};
const HEALTH_CACHE_TTL = 30000; // 30 seconds

// This route only ever forwards to TRANSCODE_SERVICES[n].transcodeUrl — a
// server-side constant, never derived from anything in the request — so the
// upstream PATH can't be influenced by a caller. What *can* leak through
// verbatim forwarding is query params and headers, so both are explicitly
// whitelisted below instead of passed through wholesale. Investigated 2026:
// neither mobileapp nor skatehive3.0 currently call this proxy for uploads
// at all (both upload directly to the transcoder hosts — see the "IMPORTANT"
// comment in ./config.ts); mobile only calls the separate /api/transcode/status
// endpoint. No query param is read by the transcoder's own /transcode route.
const ALLOWED_QUERY_PARAMS: string[] = [];
// content-type is needed for the multipart boundary; x-skatehive-upload-key
// is the transcoder's own mobile-token trust signal (getRequestAccess in the
// transcoder's server.js) — pass it through unchanged so a legitimate mobile
// caller's token still works. Everything else (Origin, Cookie, Authorization,
// X-Forwarded-For, ...) is dropped: forwarding a caller-supplied Origin in
// particular would let anyone spoof the transcoder's origin-based CORS gate
// through this proxy, regardless of where the request actually came from.
const ALLOWED_FORWARD_HEADERS = ['content-type', 'x-skatehive-upload-key'];

function buildForwardUrl(baseUrl: string, searchParams: URLSearchParams): string {
  const allowed = new URLSearchParams();
  for (const key of ALLOWED_QUERY_PARAMS) {
    for (const value of searchParams.getAll(key)) {
      allowed.append(key, value);
    }
  }
  const qs = allowed.toString();
  return qs ? `${baseUrl}?${qs}` : baseUrl;
}

function buildForwardHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of ALLOWED_FORWARD_HEADERS) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function checkServiceHealth(healthUrl: string): Promise<boolean> {
  try {
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    const response = await fetch(healthUrl, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    // Check if the response indicates the service is healthy
    const isHealthy = data.ok === true || data.healthy === true || data.status === 'ok';
    const hasCapacity = !data.capacity || Number(data.capacity.available ?? 1) > 0;
    return isHealthy && hasCapacity;
  } catch (error) {
    console.error(`Health check failed for ${healthUrl}:`, error);
    return false;
  }
}

async function getHealthyService(): Promise<string | null> {
  const now = Date.now();

  // Sort services by priority (1 = highest priority)
  const sortedServices = [...TRANSCODE_SERVICES].sort((a, b) => a.priority - b.priority);

  for (const service of sortedServices) {
    const cacheKey = service.healthUrl;
    const cached = healthCache[cacheKey];

    // Use cached result if it's still valid
    if (cached && (now - cached.lastCheck) < HEALTH_CACHE_TTL) {
      if (cached.isHealthy) {
        console.log(`Using cached healthy service: ${service.transcodeUrl}`);
        return service.transcodeUrl;
      }
      continue;
    }

    // Check health status
    const isHealthy = await checkServiceHealth(service.healthUrl);

    // Update cache
    healthCache[cacheKey] = {
      isHealthy,
      lastCheck: now
    };

    if (isHealthy) {
      console.log(`Found healthy service: ${service.transcodeUrl}`);
      return service.transcodeUrl;
    }
  }

  return null;
}

export async function GET(request: NextRequest) {
  try {
    // Find the first healthy service based on priority
    const healthyServiceUrl = await getHealthyService();

    if (!healthyServiceUrl) {
      return NextResponse.json(
        {
          error: 'No healthy transcode services available',
          message: 'All transcode services are currently unavailable. Please try again later.',
          services: TRANSCODE_SERVICES.map(s => ({
            priority: s.priority,
            name: s.name,
            healthUrl: s.healthUrl,
            transcodeUrl: s.transcodeUrl
          }))
        },
        { status: 503 }
      );
    }

    const { searchParams } = new URL(request.url);
    const finalUrl = buildForwardUrl(healthyServiceUrl, searchParams);

    console.log(`Redirecting GET request to: ${finalUrl}`);

    // Redirect to the healthy service
    return NextResponse.redirect(finalUrl, { status: 302 });

  } catch (error) {
    console.error('Error in transcode GET redirect:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Find the first healthy service based on priority
    const healthyServiceUrl = await getHealthyService();

    if (!healthyServiceUrl) {
      return NextResponse.json(
        {
          error: 'No healthy transcode services available',
          message: 'All transcode services are currently unavailable. Please try again later.',
          services: TRANSCODE_SERVICES.map(s => ({
            priority: s.priority,
            name: s.name,
            healthUrl: s.healthUrl,
            transcodeUrl: s.transcodeUrl
          }))
        },
        { status: 503 }
      );
    }

    const { searchParams } = new URL(request.url);
    const finalUrl = buildForwardUrl(healthyServiceUrl, searchParams);

    // For POST requests, forward the request body and only the whitelisted headers
    const body = await request.text();
    const headers = buildForwardHeaders(request.headers);

    console.log(`Forwarding POST request to: ${finalUrl}`);

    // Forward the POST request to the healthy service
    const response = await fetch(finalUrl, {
      method: 'POST',
      headers,
      body
    });

    // Return the response from the target endpoint
    const responseData = await response.text();
    const responseHeaders = new Headers(response.headers);

    return new Response(responseData, {
      status: response.status,
      headers: responseHeaders
    });

  } catch (error) {
    console.error('Error in transcode POST forward:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
