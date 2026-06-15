// News content service — pure unit test (no DB, no HTTP). Exercises the real
// HTML articles committed under src/content/news/ via the same import.meta.glob
// the server uses, so it also guards the frontmatter envelope of every post.
import { describe, it, expect } from "vitest";
import { listNews, getNewsPost } from "$lib/server/news.js";

describe("news service", () => {
  const posts = listNews();

  it("returns every committed post", () => {
    expect(posts.length).toBeGreaterThanOrEqual(2);
  });

  it("sorts newest first", () => {
    const dates = posts.map((p) => p.date);
    const newestFirst = [...dates].sort((a, b) => b.localeCompare(a));
    expect(dates).toEqual(newestFirst);
  });

  it("parses well-formed metadata for every post", () => {
    for (const post of posts) {
      expect(post.slug).toMatch(/^[a-z0-9-]+$/);
      expect(post.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(post.dateDisplay).not.toBe("");
      expect(post.title).not.toBe("");
    }
  });

  it("strips the body from list metadata", () => {
    for (const post of posts) {
      expect(post).not.toHaveProperty("body");
    }
  });

  it("derives the slug from the filename minus its date prefix", () => {
    for (const post of posts) {
      expect(post.slug).not.toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
    expect(getNewsPost("the-diary-is-live")).not.toBeNull();
  });

  it("exposes cover metadata (nullable url + alt string)", () => {
    for (const post of posts) {
      expect(post.cover === null || typeof post.cover === "string").toBe(true);
      expect(typeof post.coverAlt).toBe("string");
    }
    // At least one committed post ships a cover image.
    expect(posts.some((p) => p.cover !== null)).toBe(true);
  });

  it("returns a full post with a non-empty body by slug", () => {
    const [first] = posts;
    expect(first).toBeDefined();
    const post = getNewsPost(first!.slug);
    expect(post).not.toBeNull();
    expect(post!.slug).toBe(first!.slug);
    expect(post!.body.length).toBeGreaterThan(0);
  });

  it("returns null for an unknown slug", () => {
    expect(getNewsPost("does-not-exist")).toBeNull();
  });
});
