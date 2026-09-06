import { describe, expect, it } from "vitest";
import { isAllowedInstagramMediaUrl } from "./mediaValidation";

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
