// Telegram t.me/s HTML parser — unit tests.
//
// PLACEHOLDER (Phase 9 Plan 01 Wave 0). The skipped `it`s below enumerate the
// parser assertions from 09-RESEARCH.md §Validation Architecture; the parser
// itself (parseListing / parseSinglePost / view-string normalization / media
// classification / not-found detection / cursor extraction) lands in Plan 02.
// Captured fixtures already live under tests/fixtures/telegram/ — these tests
// read them with zero network at test time.
//
// Skipped suites pass vacuously so `pnpm test:unit` stays green in Wave 0.

import { describe, it } from "vitest";

describe.skip("telegram parser (filled in Plan 02)", () => {
  it.skip(
    "normalizes view strings: 227 -> 227, 18.1K -> 18100, 1.01M -> 1010000 (views-mixed.html)",
  );
  it.skip(
    "yields view_count = null for a block with no .tgme_widget_message_views span (no-views-post.html)",
  );
  it.skip(
    "treats a grouped-media album as ONE post with media_kind='album' (album-post.html, D-01)",
  );
  it.skip("skips service messages / empty-shell blocks (D-01)");
  it.skip(
    "maps a nonexistent channel to status='not_found' by ABSENCE of tgme_* markers, not HTTP status (channel-not-found.html)",
  );
  it.skip(
    "extracts the ?before=<id> cursor from a.js-messages_more_wrap[data-before] (listing-before-page.html)",
  );
  it.skip("detects end-of-history when a page has zero [data-post] blocks or no more-wrap cursor");
  it.skip(
    "extracts the thumbnail URL from a photo wrap's background-image style (listing-healthy.html)",
  );
  it.skip(
    "parses publishedAt from a.tgme_widget_message_date time[datetime] (listing-healthy.html)",
  );
  it.skip(
    "parses the channel display title from .tgme_channel_info_header_title (for data_sources, never denormalized onto posts)",
  );
});
