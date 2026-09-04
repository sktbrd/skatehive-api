import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedInstagramMediaUrl, mediaIsFetchable } from "./mediaValidation";

function fetchResponse(overrides: Partial<{ ok: boolean; status: number; type: string; contentType: string }> = {}) {
  const status = overrides.status ?? 200;
  return {
    ok: overrides.ok ?? (status >= 200 && status < 300),
    status,
    type: overrides.type ?? "basic",
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? overrides.contentType ?? "" : null) },
  };
}

describe("isAllowedInstagramMediaUrl", () => {
  it("allows each of the known gateway hosts over https", () => {
    expect(isAllowedInstagramMediaUrl("https://images.hive.blog/x.jpg")).toBe(true);
    expect(isAllowedInstagramMediaUrl("https://files.peakd.com/x.jpg")).toBe(true);
    expect(isAllowedInstagramMediaUrl("https://ipfs.skatehive.app/ipfs/abc")).toBe(true);
    expect(isAllowedInstagramMediaUrl("https://gateway.pinata.cloud/ipfs/abc")).toBe(true);
  });

  it("rejects http even for an otherwise-allowed host", () => {
    expect(isAllowedInstagramMediaUrl("http://images.hive.blog/x.jpg")).toBe(false);
  });

  it("rejects a host not on the allow-list", () => {
    expect(isAllowedInstagramMediaUrl("https://evil.example.com/x.jpg")).toBe(false);
  });

  it("rejects a garbage URL instead of throwing", () => {
    expect(isAllowedInstagramMediaUrl("not a url")).toBe(false);
  });
});

describe("mediaIsFetchable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns true immediately for a 2xx image response", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: any) => fetchResponse({ status: 200, contentType: "image/jpeg" }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(mediaIsFetchable("https://ipfs.skatehive.app/ipfs/abc")).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: "HEAD", redirect: "manual" });
  });

  it("returns false after 3 confirmed 4xx attempts", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async (_url: string, _init?: any) => fetchResponse({ status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    const promise = mediaIsFetchable("https://ipfs.skatehive.app/ipfs/missing");
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("treats a 3xx redirect as a failure rather than following it", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async (_url: string, _init?: any) => fetchResponse({ status: 302, type: "opaqueredirect" }));
    vi.stubGlobal("fetch", fetchSpy);

    const promise = mediaIsFetchable("https://ipfs.skatehive.app/ipfs/redirecting");
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe(false);
    // redirect: 'manual' was requested on every attempt — never following it ourselves.
    for (const call of fetchSpy.mock.calls) {
      expect(call[1]).toMatchObject({ redirect: "manual" });
    }
  });

  it("aborts via the signal roughly on a 5s timeout instead of hanging forever", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn((url: string, init: any) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const promise = mediaIsFetchable("https://ipfs.skatehive.app/ipfs/slow");
    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    // A network-level failure (including an abort) fails open, per the
    // existing "can't probe — don't block" policy.
    await expect(promise).resolves.toBe(true);
    expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
