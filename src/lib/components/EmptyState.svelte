<script lang="ts">
  // EmptyState — UX-03 empty-state primitive used by every list page
  // (/games, /events, /audit, /accounts/youtube, /keys/steam, items panel).
  //
  // Contract per UI-SPEC §"Empty states":
  //   - heading at display size (32px / weight 600)
  //   - body paragraph; if `exampleUrl` is set, the body's `{url}` token
  //     is REPLACED by a <code> element so the URL renders monospace
  //     (D-43 — example URLs are inert literal strings, not anchors)
  //   - optional CTA button below body
  //
  // The body string is expected to come from a Paraglide function that
  // takes a `{url}` parameter — e.g. `m.empty_games_body({ url: '<URL>' })`.
  // We split on the literal URL substring and wrap it in <code>. The
  // EmptyState test (tests/integration/empty-states.test.ts) asserts the
  // rendered HTML contains <code>...</code> wrapping the URL.
  //
  // FLAG (UI-SPEC): example URLs render with `cursor: text` (not pointer)
  // and a quiet tooltip clarifying they are inert.

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
  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-md);
    padding: var(--space-xl) var(--space-md);
    color: var(--color-text);
  }
  .heading {
    margin: 0;
    font-size: var(--font-size-display);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-heading);
  }
  .body {
    margin: 0;
    font-size: var(--font-size-body);
    line-height: var(--line-height-body);
    color: var(--color-text-muted);
    max-width: 60ch;
  }
  .example {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-label);
    line-height: var(--line-height-mono);
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    padding: 1px var(--space-xs);
    border-radius: 2px;
    cursor: text;
    word-break: break-all;
  }
  .cta {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
</style>
