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
  import SourceKindIcon from "$lib/components/SourceKindIcon.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  import QuotaStatusBanner from "$lib/components/QuotaStatusBanner.svelte";
  // RecoveryDialog is the single recovery surface across the app. The
  // dialog opens from the page head's "Recently deleted (N)" button.
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
    eventCount?: number;
  };

  // Platform group order matches the prototype's SRC_PLATFORMS list:
  // YouTube first, then Reddit. Newer platforms slot in by adapter
  // registration; the prototype only ships YouTube + Reddit but the
  // backend already produces all five enum values, so we cover them.
  const PLATFORM_ORDER: ReadonlyArray<{ kind: SourceKind; label: string }> = [
    { kind: "youtube_channel", label: "YouTube" },
    { kind: "reddit_subreddit", label: "Reddit" },
    { kind: "reddit_account", label: "Reddit" },
    { kind: "twitter_account", label: "Twitter" },
    { kind: "telegram_channel", label: "Telegram" },
    { kind: "discord_server", label: "Discord" },
  ];

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

  // Total event count across every connected source — drives the "<N>
  // events imported" half of the page-head summary.
  const totalEventCount = $derived(
    active.reduce((sum, s) => sum + (s.eventCount ?? 0), 0),
  );

  // Group active sources by platform for the prototype-style
  // sources-group-head dividers. The reddit_account and reddit_subreddit
  // kinds collapse into a single "Reddit" group; the PLATFORM_ORDER list
  // above pre-orders the groups.
  type Group = { kind: SourceKind; label: string; items: DataSourceDto[] };
  const groups: Group[] = $derived.by(() => {
    const seenKinds = new Set<SourceKind>();
    const out: Group[] = [];
    // Build one group per unique label in PLATFORM_ORDER, dedup-ing
    // reddit_account + reddit_subreddit into a single "Reddit" group.
    const labelToGroup = new Map<string, Group>();
    for (const p of PLATFORM_ORDER) {
      if (seenKinds.has(p.kind)) continue;
      seenKinds.add(p.kind);
      let g = labelToGroup.get(p.label);
      if (!g) {
        g = { kind: p.kind, label: p.label, items: [] };
        labelToGroup.set(p.label, g);
        out.push(g);
      }
    }
    for (const s of active) {
      const def = PLATFORM_ORDER.find((p) => p.kind === s.kind);
      if (!def) continue;
      const g = labelToGroup.get(def.label);
      g?.items.push(s);
    }
    return out.filter((g) => g.items.length > 0);
  });

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
  <!-- Page head — 1:1 with docs/design/v2/ui-kit/sources-page.jsx:
       title + count summary on the left, primary CTA next to the title,
       optional "Recently deleted (N)" link. -->
  <header class="page-head">
    <div class="page-head-row top">
      <div class="page-head-titlegroup">
        <h1 class="page-title">Sources</h1>
        <span class="page-head-summary">
          <b>{active.length}</b> connected
          <span class="sep">·</span>
          <b>{totalEventCount}</b> {totalEventCount === 1 ? "event" : "events"} imported
        </span>
      </div>
      <a class="btn add-source" href="/sources/new">
        {m.sources_cta_new_source()}
      </a>
      {#if deleted.length > 0}
        <button
          type="button"
          class="recovery-link"
          onclick={() => (recoveryOpen = true)}
        >
          {m.page_header_recently_deleted({ count: deleted.length })}
        </button>
      {/if}
    </div>
  </header>

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
    <div class="sources-list">
      {#each groups as group (group.label)}
        <section class="sources-group">
          <header class="sources-group-head">
            <span class="kind-icon" aria-hidden="true">
              <SourceKindIcon kind={group.kind} />
            </span>
            <h2 class="sources-group-title">{group.label}</h2>
            <span class="sources-group-count">{group.items.length}</span>
            <div class="sources-group-rule"></div>
          </header>
          <div class="sources-rows">
            {#each group.items as source (source.id)}
              <SourceRow
                {source}
                cooldownSec={data.cooldownBySource?.[source.id] ?? 0}
                pulling={data.pullingBySource?.[source.id] ?? false}
              />
            {/each}
          </div>
        </section>
      {/each}
    </div>

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
    gap: var(--s-4);
    min-width: 0;
  }

  /* Page head — 1:1 with the prototype's .page-head + .page-head-row +
   * .page-head-titlegroup + .page-head-summary. */
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-2) 0;
  }
  .page-head-row.top {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  .page-head-titlegroup {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .page-title {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    color: var(--text);
    line-height: var(--lh-tight);
    letter-spacing: -0.01em;
  }
  .page-head-summary {
    color: var(--text-3);
    font-family: var(--f-mono);
    font-size: 11.5px;
    letter-spacing: 0.01em;
    font-variant-numeric: tabular-nums;
  }
  .page-head-summary b {
    color: var(--text-2);
    font-weight: var(--w-sb);
  }
  .page-head-summary .sep {
    margin: 0 4px;
    color: var(--text-4);
    opacity: 0.6;
  }

  /* "+ Add source" — primary CTA inline with the title. Matches the
   * prototype's .btn.add-event treatment used across feed / sources. */
  .btn.add-source {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    min-height: var(--hit-lg);
    padding: 0 var(--s-4);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-sb);
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .btn.add-source:hover {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .recovery-link {
    background: transparent;
    border: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
    font-size: var(--t-13);
    color: var(--text-3);
    text-decoration: underline;
  }
  .recovery-link:hover {
    color: var(--accent);
  }

  /* Sources list — flex column of platform groups, generously spaced
   * (--s-7 between groups, --s-2 between rows in a group). */
  .sources-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-7);
    padding-bottom: var(--s-6);
  }
  .sources-group {
    display: flex;
    flex-direction: column;
  }
  .sources-group-head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-3) 0;
  }
  .sources-group-head .kind-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
  .sources-group-title {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    color: var(--text-2);
    letter-spacing: 0.01em;
  }
  .sources-group-count {
    font-family: var(--f-mono);
    font-size: var(--t-12);
    color: var(--text-3);
    padding: 0 6px;
    background: var(--surface-2);
    border-radius: var(--r-pill);
  }
  .sources-group-rule {
    flex: 1;
    height: 1px;
    background: var(--border-hairline);
  }
  .sources-rows {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  /* Per-platform group head kind-icon color — mirrors the SourceRow's
   * --card-accent so the group divider reads in the same color as its
   * member rows. */
  .sources-group:nth-of-type(1) .sources-group-head .kind-icon { color: var(--k-youtube); }
  .sources-group:nth-of-type(2) .sources-group-head .kind-icon { color: var(--k-reddit); }
  .sources-group:nth-of-type(3) .sources-group-head .kind-icon { color: var(--k-twitter); }
  .sources-group:nth-of-type(4) .sources-group-head .kind-icon { color: var(--k-telegram); }
  .sources-group:nth-of-type(5) .sources-group-head .kind-icon { color: var(--k-discord); }

  .quota-disclosure {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface-2);
  }
  .quota-disclosure > summary {
    padding: var(--s-2) var(--s-4);
    cursor: pointer;
    color: var(--text-2);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    user-select: none;
  }
  .quota-disclosure > summary:hover {
    color: var(--text);
  }

  @media (max-width: 480px) {
    .page-head-row.top {
      flex-direction: column;
      align-items: stretch;
    }
    .btn.add-source {
      align-self: flex-start;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .btn.add-source {
      transition: none;
    }
  }
</style>
