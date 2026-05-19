// Shared shape + serializer for the t3 post payload — single source of
// truth for the subset of fields the diary persists into
// `reddit_posts.metadata` for the per-post detail view.
//
// Previously inlined in four handlers (post-single, post-batch,
// sub-poll, author-poll). The Reddit API may add fields any time; one
// place to track means a future addition is one diff, not four.
//
// Field selection rationale:
//   is_self / link_url           — diary's "what kind of post?" hint
//   body_excerpt (≤200 chars)    — preview without storing the full
//                                  selftext (selftext can be 40k+ chars
//                                  for novella-length write-ups; the
//                                  reddit_posts row is meant to be
//                                  metadata-thin, NOT a content store).
//   over_18 / spoiler / stickied — UX hint flags
//   locked / archived            — lifecycle hints (no comments / no votes)
//   link_flair_text              — subreddit moderator tag
//   crosspost_parent_id          — track which post was crossposted

export interface RedditPostT3Shape {
  is_self?: boolean;
  url?: string;
  selftext?: string;
  over_18?: boolean;
  spoiler?: boolean;
  stickied?: boolean;
  locked?: boolean;
  archived?: boolean;
  link_flair_text?: string | null;
  crosspost_parent?: string | null;
}

/** Build the `reddit_posts.metadata` jsonb payload from a t3 row.
 *  Pure function (no I/O); reusable across every code path that
 *  UPSERTs reddit_posts. */
export function buildPostMetadata(t3: RedditPostT3Shape): Record<string, unknown> {
  return {
    is_self: t3.is_self ?? false,
    link_url: t3.url ?? null,
    body_excerpt:
      typeof t3.selftext === "string" && t3.selftext.length > 0 ? t3.selftext.slice(0, 200) : null,
    over_18: t3.over_18 ?? false,
    spoiler: t3.spoiler ?? false,
    stickied: t3.stickied ?? false,
    locked: t3.locked ?? false,
    archived: t3.archived ?? false,
    link_flair_text: t3.link_flair_text ?? null,
    crosspost_parent_id: t3.crosspost_parent ?? null,
  };
}
