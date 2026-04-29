import { describe, it, expect } from "vitest";
import { sortByLabel } from "../../src/lib/util/sort-kinds.js";

describe("Plan 02.1-20: sortByLabel utility", () => {
  it("returns [] for empty input", () => {
    expect(sortByLabel([], () => "")).toEqual([]);
  });

  it("sorts strings alphabetically when getLabel is identity", () => {
    expect(sortByLabel(["c", "a", "b"], (s) => s)).toEqual(["a", "b", "c"]);
  });

  it("sorts objects by their translated label", () => {
    const labels: Record<string, string> = {
      youtube_video: "YouTube video",
      post: "Post",
      conference: "Conference",
    };
    const input = [{ value: "youtube_video" }, { value: "post" }, { value: "conference" }];
    const out = sortByLabel(input, (item) => labels[item.value]!);
    expect(out.map((i) => i.value)).toEqual(["conference", "post", "youtube_video"]);
  });

  it("uses locale-stable comparison (Intl.Collator base sensitivity)", () => {
    // Á sorts adjacent to A in en-US accent-insensitive primary collation.
    // Either [A, Á, Z] or [Á, A, Z] is acceptable — the assertion is
    // that A and Á cluster before Z (accent-insensitive primary sort).
    const out = sortByLabel(["Z", "Á", "A"], (s) => s);
    expect(out[0]).not.toBe("Z");
    expect(out[1]).not.toBe("Z");
    expect(out[2]).toBe("Z");
  });

  it("is stable for equal labels (input order preserved)", () => {
    const input = [
      { id: 1, label: "x" },
      { id: 2, label: "x" },
      { id: 3, label: "y" },
    ];
    const out = sortByLabel(input, (i) => i.label);
    expect(out.map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it("does not mutate the input array", () => {
    const input = ["c", "a", "b"];
    sortByLabel(input, (s) => s);
    expect(input).toEqual(["c", "a", "b"]);
  });
});
