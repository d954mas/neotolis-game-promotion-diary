/**
 * Browser test asserting EventDetailContent renders identical fields
 * whether mounted via <EventDetailModal> in /feed?event=... or via
 * the /events/[id] standard route shell (D-05, D-06).
 *
 * Wave 2 Plan 09 ships EventDetailContent + EventDetailModal; Wave 3
 * Plan 10 wires them into /feed and /events/[id]. This file scaffolds
 * the parity contract.
 *
 * Contract anchors:
 *   - D-05 — Centered modal 760px overlay is the primary detail surface
 *            when opening from feed card click; URL updates to
 *            /feed?event=ev_123 (filter state preserved); Esc / X / scrim
 *            click / browser back → modal closes
 *   - D-06 — /events/[id] route stays as SSR full-page fallback for
 *            direct-link / paste-into-browser / SEO; both render the
 *            same <EventDetailContent> component
 *
 * Wave 2 activation: un-comment the component imports below; Wave 2
 * Plan 09 lands EventDetailContent + EventDetailModal under
 * src/lib/components/event-detail/. Wave 3 Plan 10 wires the modal
 * into /feed and the page into /events/[id].
 */

import { describe, it } from "vitest";
// Wave 2 Plan 09 ACTIVATES these imports:
// import EventDetailContent from "../../src/lib/components/event-detail/EventDetailContent.svelte";
// import EventDetailModal from "../../src/lib/components/event-detail/EventDetailModal.svelte";

describe("EventDetailContent dual-render parity (Wave 2 Plan 09 + Wave 3 Plan 10)", () => {
  it.skip(
    "Wave 2 Plan 09: renders title field identically in modal mount and bare mount (D-05, D-06)",
    async () => {},
  );
  it.skip(
    "Wave 2 Plan 09: renders notes field identically in modal and bare",
    async () => {},
  );
  it.skip(
    "Wave 2 Plan 09: renders games chip row identically",
    async () => {},
  );
  it.skip(
    "Wave 2 Plan 09: renders kind tag + KindIcon identically",
    async () => {},
  );
  it.skip(
    "Wave 2 Plan 09: renders stats (views/likes/comments) identically for kind=youtube_video",
    async () => {},
  );
  it.skip(
    "Wave 2 Plan 09: inline-edit title pencil click sets draft to current value in both mounts",
    async () => {},
  );
  it.skip(
    "Wave 2 Plan 09: EventDetailModal.showModal() called on $effect mount; close() called on unmount (D-05)",
    async () => {},
  );
  it.skip(
    "Wave 3 Plan 10: EventDetailModal oncancel fires onClose callback with URL state cleared — back-button removes ?event= param (D-05)",
    async () => {},
  );
});
