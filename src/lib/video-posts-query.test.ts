import { describe, expect, it } from "vitest";
import { buildVideoPostsQuery } from "./video-posts-query";

function paramMap(params: { name: string; value: any }[]) {
  return Object.fromEntries(params.map((p) => [p.name, p.value]));
}

describe("buildVideoPostsQuery", () => {
  it("filters on c.author and binds the given handle when author is provided", () => {
    const { query, params } = buildVideoPostsQuery("hive-173115", "", "tonyhawk", 20, 0);

    expect(query).toContain("c.author = @author");
    expect(paramMap(params).author).toBe("tonyhawk");
  });

  it("leaves every post unfiltered by author when none is given (empty string param)", () => {
    const { query, params } = buildVideoPostsQuery("hive-173115", "", "", 20, 0);

    expect(query).toContain("@author = ''");
    expect(paramMap(params).author).toBe("");
  });

  it("keeps limit/offset pagination params unchanged whether or not author is set", () => {
    const withoutAuthor = paramMap(buildVideoPostsQuery("hive-173115", "", "", 20, 40).params);
    const withAuthor = paramMap(buildVideoPostsQuery("hive-173115", "", "tonyhawk", 20, 40).params);

    expect(withoutAuthor.limit).toBe(20);
    expect(withoutAuthor.offset).toBe(40);
    expect(withAuthor.limit).toBe(20);
    expect(withAuthor.offset).toBe(40);
  });
});
