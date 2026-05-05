// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-09.
// End-to-end smoke for the manual-paste → auto-poll handoff: pasting
// a YouTube URL creates an event with source_id=NULL; the next
// scheduler tick still picks it up for poll.active because the tier
// resolver keys on (last_polled_at, occurred_at), not source_id.
// Manual-paste events ARE pollable; CONTEXT D-05 unified contract.
import { describe, it } from "vitest";

describe("ingest paste-then-poll (Plan 03.0-09)", () => {
  it.skip("paste YouTube URL → event created with source_id=NULL → next scheduler tick enqueues poll.active → mock YouTube returns ok → snapshot row exists — activated in Plan 03.0-09", () => {});
});
