<script lang="ts">
  // EmptyState — empty-state primitive used by every list page
  // (/games, /events, /audit, /sources, /keys/steam, items panel).
  //
  // Contract:
  //   - heading at display size (32px / weight 600)
  //   - body paragraph; if `exampleUrl` is set, the body's `{url}` token
  //     is REPLACED by a <code> element so the URL renders monospace
  //     (example URLs are inert literal strings, not anchors)
  //   - optional CTA button below body
  //
  // The body string is expected to come from a Paraglide function that
  // takes a `{url}` parameter — e.g. `m.empty_games_body({ url: '<URL>' })`.
  // We split on the literal URL substring and wrap it in <code>. The
  // EmptyState test (tests/integration/empty-states.test.ts) asserts the
  // rendered HTML contains <code>...</code> wrapping the URL.
  //
  // Example URLs render with `cursor: text` (not pointer) and a quiet
  // tooltip clarifying they are inert.

  let {
    heading,
    body,
    exampleUrl,
    ctaLabel,
    onCta,
  }: {
    heading: string;
    body: string;
    exampleUrl?: string;
    ctaLabel?: string;
    onCta?: () => void;
  } = $props();

  // Split body around the example URL so we can wrap that single token in
  // <code>. Paraglide already substituted the URL into `body`; we don't
  // re-substitute, we just locate and wrap.
  const segments = $derived.by((): Array<{ kind: "text" | "code"; text: string }> => {
    if (!exampleUrl || !body.includes(exampleUrl)) {
      return [{ kind: "text", text: body }];
    }
    const idx = body.indexOf(exampleUrl);
    const out: Array<{ kind: "text" | "code"; text: string }> = [];
    if (idx > 0) out.push({ kind: "text", text: body.slice(0, idx) });
    out.push({ kind: "code", text: exampleUrl });
    const after = body.slice(idx + exampleUrl.length);
    if (after.length > 0) out.push({ kind: "text", text: after });
    return out;
  });
</script>

<div class="empty">
  <h2 class="heading">{heading}</h2>
  <p class="body">
    {#each segments as seg}
      {#if seg.kind === "code"}
        <code class="example" title="Example only — copy and paste into the box above"
          >{seg.text}</code
        >
      {:else}
        {seg.text}
      {/if}
    {/each}
  </p>
  {#if ctaLabel && onCta}
    <button type="button" class="cta" onclick={onCta}>{ctaLabel}</button>
  {/if}
</div>

<style>
  /* v2 EmptyState — denser type with --t-30 display heading + --t-14 body
   * + --hit-lg accent CTA. */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-4);
    padding: var(--s-8) var(--s-4);
    color: var(--text);
  }
  .heading {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-30);
    font-weight: var(--w-sb);
    line-height: var(--lh-tight);
    color: var(--text);
  }
  .body {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-14);
    line-height: var(--lh-body);
    color: var(--text-2);
    max-width: 60ch;
  }
  .example {
    font-family: var(--f-mono);
    font-size: var(--t-13);
    line-height: var(--lh-body);
    color: var(--text);
    background: var(--surface-3);
    border: 1px solid var(--border);
    padding: var(--s-0) var(--s-1);
    border-radius: var(--r-xs);
    cursor: text;
    word-break: break-all;
  }
  .cta {
    min-height: var(--hit-lg);
    padding: var(--s-2) var(--s-4);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .cta:hover {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  @media (prefers-reduced-motion: reduce) {
    .cta {
      transition: none;
    }
  }
</style>
