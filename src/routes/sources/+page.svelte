<script lang="ts">
  // /sources — data source registry.
  //
  // One unified list of every data_source the user has registered (any of
  // 5 kinds; only youtube_channel functional today — see FUNCTIONAL_KINDS
  // gate). Soft-deleted sources show in a collapsed <details> section with
  // a RetentionBadge and a Restore action (60-day window per
  // env.RETENTION_DAYS).
  //
  // The "+ Add data source" CTA navigates to /sources/new (a full-page form
  // — same pattern as /games/new and /events/new). NOT an inline dialog:
  // the kind picker has 5 chips with tooltips and earns its own page
  // surface.

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import SourceRow from "$lib/components/SourceRow.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  // Shared PageHeader replaces the inline <header class="head"> + .cta
  // block. The `sticky` prop keeps the CTA reachable while a long source
  // list scrolls.
  import PageHeader from "$lib/components/PageHeader.svelte";
  import QuotaStatusBanner from "$lib/components/QuotaStatusBanner.svelte";
  // RecoveryDialog is the single recovery surface across the app. The
  // dialog opens from PageHeader's "Recently deleted (N)" button.
  // RetentionBadge + per-row Restore live INSIDE the dialog (the dialog
  // mirrors the visual treatment SourceRow used for soft-deleted rows).
  import RecoveryDialog from "$lib/components/RecoveryDialog.svelte";
  import type { PageData } from "./$types";

  type SourceKind =
    | "youtube_channel"
    | "reddit_account"
    | "reddit_subreddit"
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

  // Live refresh while any source has an active cooldown (worker is
  // processing a pull). Server loader re-runs every 3s; SourceRow updates
  // last_polled_at, event range, and the cooldown countdown without manual
  // page reload. Stops polling once all cooldowns hit 0.
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    // Live-refresh while ANY source is actively pulling (worker job in
    // pgboss state active/created/retry) OR has cooldown remaining.
    // Stops when both go to zero.
    const anyPulling = Object.values(data.pullingBySource ?? {}).some(Boolean);
    const anyCooldown = Object.values(data.cooldownBySource ?? {}).some((sec) => sec > 0);
    const anyActive = anyPulling || anyCooldown;
    if (anyActive && pollTimer === null) {
      pollTimer = setInterval(() => {
        void invalidateAll();
      }, 3000);
    } else if (!anyActive && pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    return () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  });
  const active = $derived(data.active as DataSourceDto[]);
  const deleted = $derived(data.deleted as DataSourceDto[]);

  // RecoveryDialog open state. Opened by PageHeader's "Recently deleted (N)"
  // button; closed by Escape, backdrop click, the dialog's × button, or
  // auto-closes when the last recoverable item is restored (same contract
  // as /feed and /games).
  let recoveryOpen = $state(false);
  let restoreError = $state<string | null>(null);

  // Map deleted (toDataSourceDto-projected, no ciphertext) into the
  // RecoveryDialog's generic { id, name, deletedAt } shape. `displayName`
  // is nullable on data_sources (the user may not have set one); fall
  // back to handleUrl so every row has a recognizable label.
  const recoveryItems = $derived(
    deleted.map((s) => ({
      id: s.id,
      name: s.displayName ?? s.handleUrl,
      deletedAt: s.deletedAt,
    })),
  );

  async function restoreSource(id: string): Promise<void> {
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
      // If that was the last recoverable item, close the dialog so the
      // user is not stuck staring at "Nothing to recover" — the parent
      // also stops rendering the PageHeader CTA at the same time
      // (deletedCount falls to 0). Same pattern as /feed and /games.
      if (deleted.length <= 1) recoveryOpen = false;
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
    deletedCount={deleted.length}
    onOpenRecovery={() => (recoveryOpen = true)}
  />

  <!-- Per-platform API quota banner. Important info but rarely needed
       during normal use; collapsed under a disclosure to reduce noise on
       the list view. User opens when wanting to check quota state
       explicitly. -->
  {#if data.quotaPlatforms.length > 0 || data.redditQuota}
    <details class="quota-disclosure">
      <summary>API usage today</summary>
      <QuotaStatusBanner platforms={data.quotaPlatforms} redditQuota={data.redditQuota} />
    </details>
  {/if}

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
          <SourceRow
            {source}
            cooldownSec={data.cooldownBySource?.[source.id] ?? 0}
            pulling={data.pullingBySource?.[source.id] ?? false}
          />
        </li>
      {/each}
    </ul>

    <!-- The bottom-of-page <details class="deleted-sources"> recovery
         block was removed; the InlineError used to surface 422
         retention_expired stays here so the user sees feedback even when
         the modal is closed. -->
    {#if restoreError}
      <InlineError message={restoreError} />
    {/if}
  {/if}

  <!-- Same RecoveryDialog modal as /feed and /games. The dialog mounts
       only when deleted.length > 0; the dialog itself still defends
       against the empty case. -->
  {#if deleted.length > 0}
    <RecoveryDialog
      open={recoveryOpen}
      items={recoveryItems}
      entityType="source"
      retentionDays={data.retentionDays}
      onClose={() => (recoveryOpen = false)}
      onRestore={restoreSource}
    />
  {/if}
</section>

<style>
  .sources {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  /* Inline .head + .cta CSS removed — replaced by the shared
   * <PageHeader sticky> component (see top of file). The sticky-top: 72px
   * + background fill is preserved on PageHeader's .page-header.sticky
   * rule. */
  .sources-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  /* .deleted-sources, .deleted-row, and .restore CSS removed alongside the
   * bottom-of-page <details> recovery block. RecoveryDialog owns the
   * surface (same component on /feed and /games). */
  .quota-disclosure {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .quota-disclosure > summary {
    padding: var(--space-sm) var(--space-md);
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    user-select: none;
  }
  .quota-disclosure > summary:hover {
    color: var(--color-text);
  }
</style>
