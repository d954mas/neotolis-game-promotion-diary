// Phase 03.0.1 — pure helper tests for catch-up boundaries.
//
// `computeSinceForRefresh` produces the {newSide, oldSide} pair worker
// handlers consume to decide what pollContent calls to make. Pure
// function — easy to exercise edge cases без integration setup.

import { describe, it, expect } from "vitest";
import { computeSinceForRefresh } from "../../src/lib/server/services/data-sources.js";

const TARGET = new Date("2024-01-01T00:00:00.000Z");
const FRONTIER_AT_TARGET = new Date("2024-01-01T00:00:00.000Z");
const FRONTIER_AFTER_TARGET = new Date("2024-03-15T00:00:00.000Z"); // newer than target → gap exists
const FRONTIER_BEFORE_TARGET = new Date("2023-06-01T00:00:00.000Z"); // older than target → covered
const LATEST_EVENT = new Date("2024-05-09T12:00:00.000Z");

describe("computeSinceForRefresh", () => {
  describe("newSide", () => {
    it("returns latest event timestamp when source has events", () => {
      const r = computeSinceForRefresh(
        {
          backfillOldestAt: FRONTIER_AT_TARGET,
          backfillComplete: false,
          backfillTargetSince: TARGET,
        },
        LATEST_EVENT,
      );
      expect(r.newSide).toEqual(LATEST_EVENT);
    });

    it("returns null when source has no events yet (initial pull)", () => {
      const r = computeSinceForRefresh(
        { backfillOldestAt: null, backfillComplete: false, backfillTargetSince: TARGET },
        null,
      );
      expect(r.newSide).toBeNull();
    });
  });

  describe("oldSide", () => {
    it("returns target when frontier null (first pull) and not complete", () => {
      const r = computeSinceForRefresh(
        { backfillOldestAt: null, backfillComplete: false, backfillTargetSince: TARGET },
        LATEST_EVENT,
      );
      expect(r.oldSide).toEqual(TARGET);
    });

    it("returns target when frontier hasn't reached target (gap exists)", () => {
      const r = computeSinceForRefresh(
        {
          backfillOldestAt: FRONTIER_AFTER_TARGET,
          backfillComplete: false,
          backfillTargetSince: TARGET,
        },
        LATEST_EVENT,
      );
      expect(r.oldSide).toEqual(TARGET);
    });

    it("returns null when frontier == target (caught up)", () => {
      const r = computeSinceForRefresh(
        {
          backfillOldestAt: FRONTIER_AT_TARGET,
          backfillComplete: false,
          backfillTargetSince: TARGET,
        },
        LATEST_EVENT,
      );
      expect(r.oldSide).toBeNull();
    });

    it("returns null when frontier is older than target (already covered more)", () => {
      const r = computeSinceForRefresh(
        {
          backfillOldestAt: FRONTIER_BEFORE_TARGET,
          backfillComplete: false,
          backfillTargetSince: TARGET,
        },
        LATEST_EVENT,
      );
      expect(r.oldSide).toBeNull();
    });

    it("returns null when backfill_complete=true (no more older to pull)", () => {
      const r = computeSinceForRefresh(
        {
          backfillOldestAt: FRONTIER_AFTER_TARGET,
          backfillComplete: true,
          backfillTargetSince: TARGET,
        },
        LATEST_EVENT,
      );
      expect(r.oldSide).toBeNull();
    });

    it("returns null when backfill_target_since is null (no target configured)", () => {
      const r = computeSinceForRefresh(
        { backfillOldestAt: null, backfillComplete: false, backfillTargetSince: null },
        LATEST_EVENT,
      );
      expect(r.oldSide).toBeNull();
    });
  });

  describe("combined scenarios", () => {
    it("first-ever refresh: no events, no frontier, target set → oldSide pulls everything", () => {
      const r = computeSinceForRefresh(
        { backfillOldestAt: null, backfillComplete: false, backfillTargetSince: TARGET },
        null,
      );
      expect(r.newSide).toBeNull();
      expect(r.oldSide).toEqual(TARGET);
    });

    it("subsequent refresh with gap: events exist + frontier above target → both sides pull", () => {
      const r = computeSinceForRefresh(
        {
          backfillOldestAt: FRONTIER_AFTER_TARGET,
          backfillComplete: false,
          backfillTargetSince: TARGET,
        },
        LATEST_EVENT,
      );
      expect(r.newSide).toEqual(LATEST_EVENT);
      expect(r.oldSide).toEqual(TARGET);
    });

    it("caught up: events exist + frontier at target → only newSide pulls (newer events)", () => {
      const r = computeSinceForRefresh(
        {
          backfillOldestAt: FRONTIER_AT_TARGET,
          backfillComplete: false,
          backfillTargetSince: TARGET,
        },
        LATEST_EVENT,
      );
      expect(r.newSide).toEqual(LATEST_EVENT);
      expect(r.oldSide).toBeNull();
    });

    it("complete + caught up: nothing to pull", () => {
      const r = computeSinceForRefresh(
        {
          backfillOldestAt: FRONTIER_AT_TARGET,
          backfillComplete: true,
          backfillTargetSince: TARGET,
        },
        LATEST_EVENT,
      );
      expect(r.newSide).toEqual(LATEST_EVENT); // worker still tries newSide пользователь может опубликовать новое
      expect(r.oldSide).toBeNull();
    });

    it("'all' sentinel target (1970): pulls back to epoch when frontier above", () => {
      const epoch = new Date("1970-01-01T00:00:00.000Z");
      const r = computeSinceForRefresh(
        {
          backfillOldestAt: FRONTIER_AFTER_TARGET,
          backfillComplete: false,
          backfillTargetSince: epoch,
        },
        LATEST_EVENT,
      );
      expect(r.oldSide).toEqual(epoch);
    });
  });
});
