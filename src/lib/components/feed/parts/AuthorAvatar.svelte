<script lang="ts">
  // AuthorAvatar — leftmost meaningful glyph after the selection checkbox
  // in .card-meta. Two visual states:
  //   - mine: accent fill + first character of currentUserName (or "Y"
  //           when name unknown)
  //   - unknown: dashed neutral circle with "?"
  //
  // Pure presentational — no business logic, no event handlers. The
  // parent decides whether authorIsMe is true; this component only
  // renders the glyph.
  //
  // CSS class hooks (.author-avatar / .mine / .unknown / data-mine)
  // mirror the original FeedCard markup — the audit-render integration
  // tests grep these class strings, so changes here MUST land with
  // matching test updates.

  import { m } from "$lib/paraglide/messages.js";

  let {
    authorIsMe,
    currentUserName,
  }: {
    authorIsMe: boolean;
    currentUserName?: string;
  } = $props();

  const tooltip = $derived.by((): string => {
    if (authorIsMe) {
      const name = (currentUserName ?? "").trim();
      return name ? `${name} (you)` : "You";
    }
    return "Unknown author";
  });

  const glyph = $derived.by((): string => {
    if (authorIsMe) {
      const name = (currentUserName ?? "").trim();
      return name ? name.charAt(0).toUpperCase() : "Y";
    }
    return "?";
  });
</script>

<span
  class="author-avatar"
  class:mine={authorIsMe}
  class:unknown={!authorIsMe}
  data-mine={authorIsMe ? "1" : "0"}
  title={tooltip}
  aria-label={authorIsMe
    ? m.author_avatar_mine_aria({ name: currentUserName ?? "you" })
    : m.author_avatar_unknown_aria()}
>
  {glyph}
</span>

<style>
  /* Author avatar styles cloned from the original FeedCard.svelte.
   * Kept local to this component so the visual contract is one place. */
  .author-avatar {
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--text-4);
    font-family: var(--f-sans);
    font-size: 11px;
    font-weight: var(--w-md);
    letter-spacing: 0;
    border: 1px dashed var(--border-2);
    cursor: default;
  }
  .author-avatar.mine,
  .author-avatar[data-mine="1"] {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
    border-style: solid;
    font-weight: var(--w-sb);
    font-size: 10.5px;
    letter-spacing: 0.02em;
    box-shadow: 0 0 0 1.5px color-mix(in oklab, var(--accent) 35%, transparent);
  }

  @media (prefers-reduced-motion: reduce) {
    .author-avatar {
      transition: none;
    }
  }
</style>
