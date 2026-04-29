<script lang="ts">
  // /sources — data source registry (Phase 2.1 SOURCES-01 / SOURCES-02).
  //
  // Replaces the retired Phase 2 per-platform accounts page. One unified list of every
  // data_source the user has registered (any of 5 kinds; only youtube_channel
  // functional in 2.1 — see Plan 02.1-04 FUNCTIONAL_KINDS gate). Soft-deleted
  // sources show in a collapsed <details> section with a RetentionBadge and
  // a Restore action (60-day window per env.RETENTION_DAYS).
  //
  // The "+ Add data source" CTA navigates to /sources/new (a full-page form
  // per CONTEXT D-09 — same pattern as /games/new and /events/new). NOT an
  // inline dialog: the kind picker has 5 chips with phase tooltips and earns
  // its own page surface.

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import SourceRow from "$lib/components/SourceRow.svelte";
  import RetentionBadge from "$lib/components/RetentionBadge.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  // Plan 02.1-25 (UAT-NOTES.md §3.1-polish): shared PageHeader replaces the
  // inline <header class="head"> + .cta block. The `sticky` prop preserves
  // Plan 02.1-22's §2.2-bug closure (CTA reachable while a long source list
  // scrolls).
  import PageHeader from "$lib/components/PageHeader.svelte";
  import type { PageData } from "./$types";

  type SourceKind =
    | "youtube_channel"
    | "reddit_account"
    | "twitter_account"
    | "telegram_channel"
    | "discord_server";

  type DataSourceDto = {
    id: string;
    kind: SourceKind;
    handleUrl: string;
    displayName: string | null;
    isOwnedByMe: boolean;
    autoImport: boolean;
    deletedAt: Date | string | null;
  };

  let { data }: { data: PageData } = $props();
  const active = $derived(data.active as DataSourceDto[]);
  const deleted = $derived(data.deleted as DataSourceDto[]);

  let restoreError = $state<string | null>(null);

  async function restore(id: string): Promise<void> {
    restoreError = null;
    try {
      const res = await fetch(`/api/sources/${id}/restore`, { method: "POST" });
      if (!res.ok) {
        if (res.status === 422) {
          let body: { error?: string } = {};
          try {
            body = (await res.json()) as { error?: string };
          } catch {
            // ignore body parse failures
          }
          if (body.error === "retention_expired") {
            restoreError = m.error_server_generic();
            return;
          }
        }
        restoreError = m.error_server_generic();
        return;
      }
      await invalidateAll();
    } catch {
      restoreError = m.error_network();
    }
  }
</script>

<section class="sources">
  <PageHeader
    title="Data sources"
    cta={{ href: "/sources/new", label: m.sources_cta_new_source() }}
    sticky
  />

  {#if active.length === 0 && deleted.length === 0}
    <EmptyState
      heading={m.empty_sources_heading()}
      body={m.empty_sources_body()}
      exampleUrl="@RickAstleyYT"
      ctaLabel={m.sources_cta_new_source()}
      onCta={() => {
        window.location.href = "/sources/new";
      }}
    />
  {:else}
    <ul class="sources-list">
      {#each active as source (source.id)}
        <li>
          <SourceRow {source} />
        </li>
      {/each}
    </ul>

    {#if deleted.length > 0}
      <details class="deleted-sources">
        <summary>{`Show ${deleted.length} deleted source${deleted.length === 1 ? "" : "s"}`}</summary>
        <ul class="sources-list">
          {#each deleted as source (source.id)}
            <li class="deleted-row">
              <SourceRow {source} />
              {#if source.deletedAt}
                <RetentionBadge deletedAt={source.deletedAt} retentionDays={data.retentionDays} />
              {/if}
              <button type="button" class="restore" onclick={() => restore(source.id)}>
                {m.common_restore()}
              </button>
            </li>
          {/each}
        </ul>
        {#if restoreError}
          <InlineError message={restoreError} />
        {/if}
      </details>
    {/if}
  {/if}
</section>

<style>
  .sources {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  /* Plan 02.1-25: inline .head + .cta CSS removed — replaced by the shared
   * <PageHeader sticky> component (see top of file). Plan 02.1-22's
   * sticky-top: 72px + background fill is preserved on PageHeader's
   * .page-header.sticky rule. */
  .sources-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .deleted-sources {
    margin-top: var(--space-lg);
    padding: var(--space-sm) 0;
    color: var(--color-text-muted);
    border-top: 1px dashed var(--color-border);
  }
  .deleted-sources summary {
    cursor: pointer;
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    padding: var(--space-xs) 0;
  }
  .deleted-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .restore {
    align-self: flex-start;
    min-height: 36px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-label);
  }
</style>
