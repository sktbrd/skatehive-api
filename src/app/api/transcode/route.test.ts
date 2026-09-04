import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const FAKE_TRANSCODE_URL = "https://fake-worker.test/transcode";
const FAKE_HEALTH_URL = "https://fake-worker.test/healthz";

function healthyResponse() {
  return { ok: true, status: 200, json: async () => ({ ok: true, capacity: { available: 1 } }) };
}

async function loadRoute(forwardImpl?: (url: string, init?: any) => Promise<any>) {
  vi.doMock("./config", () => ({
    TRANSCODE_SERVICES: [
      { priority: 1, name: "Fake Worker", healthUrl: FAKE_HEALTH_URL, transcodeUrl: FAKE_TRANSCODE_URL },
    ],
  }));
  vi.resetModules();
  const { POST } = await import("./route");

  const fetchSpy = vi.fn(async (url: string, init?: any) => {
    if (url === FAKE_HEALTH_URL) return healthyResponse();
    if (forwardImpl) return forwardImpl(url, init);
    return { ok: true, status: 200, text: async () => "{}", headers: new Headers() };
  });
  vi.stubGlobal("fetch", fetchSpy);

  return { POST, fetchSpy };
}

describe("POST /api/transcode (proxy)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards to the fixed upstream transcodeUrl regardless of query/body content trying to redirect it", async () => {
    const { POST, fetchSpy } = await loadRoute();

    const req = new NextRequest(
      "http://localhost/api/transcode?path=/other-endpoint&transcodeUrl=https://evil.example.com/steal",
      { method: "POST", body: "irrelevant body", headers: { "content-type": "text/plain" } }
    );
    await POST(req);

    const forwardCall = fetchSpy.mock.calls.find((c) => c[0] !== FAKE_HEALTH_URL);
    expect(forwardCall).toBeTruthy();
    const forwardedUrl = new URL(forwardCall![0] as string);
    expect(forwardedUrl.origin + forwardedUrl.pathname).toBe(FAKE_TRANSCODE_URL);
  });

  it("strips query params that aren't on the whitelist", async () => {
    const { POST, fetchSpy } = await loadRoute();

    const req = new NextRequest("http://localhost/api/transcode?foo=bar&debug=true", {
      method: "POST",
      body: "x",
      headers: { "content-type": "text/plain" },
    });
    await POST(req);

    const forwardCall = fetchSpy.mock.calls.find((c) => c[0] !== FAKE_HEALTH_URL);
    const forwardedUrl = new URL(forwardCall![0] as string);
    expect(forwardedUrl.search).toBe("");
  });

  it("forwards only content-type and the mobile-upload-token header, dropping everything else", async () => {
    const { POST, fetchSpy } = await loadRoute();

    const req = new NextRequest("http://localhost/api/transcode", {
      method: "POST",
      body: "x",
      headers: {
        "content-type": "multipart/form-data; boundary=abc",
        "x-skatehive-upload-key": "mobile-secret",
        origin: "https://spoofed-origin.example.com",
        cookie: "userbase_refresh=some-session-token",
        authorization: "Bearer some-token",
        "x-forwarded-for": "1.2.3.4",
      },
    });
    await POST(req);

    const forwardCall = fetchSpy.mock.calls.find((c) => c[0] !== FAKE_HEALTH_URL);
    const forwardedHeaders: Headers = forwardCall![1].headers;
    expect(forwardedHeaders.get("content-type")).toBe("multipart/form-data; boundary=abc");
    expect(forwardedHeaders.get("x-skatehive-upload-key")).toBe("mobile-secret");
    expect(forwardedHeaders.get("origin")).toBeNull();
    expect(forwardedHeaders.get("cookie")).toBeNull();
    expect(forwardedHeaders.get("authorization")).toBeNull();
    expect(forwardedHeaders.get("x-forwarded-for")).toBeNull();
  });
});
