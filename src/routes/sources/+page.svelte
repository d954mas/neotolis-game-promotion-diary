<script lang="ts">
  // /sources — data source registry.
  //
  // One unified list of every data_source the user has registered (any of
  // 5 kinds; only youtube_channel functional today — see FUNCTIONAL_KINDS
  // gate). Supports ?view=trash to render soft-deleted sources as full
  // SourceRow cards with Restore + Delete forever actions (same pattern
  // as /feed?view=trash).

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import SourceRow from "$lib/components/SourceRow.svelte";
  import SourceKindIcon from "$lib/components/SourceKindIcon.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  import QuotaStatusBanner from "$lib/components/QuotaStatusBanner.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import Toast from "$lib/components/shared/Toast.svelte";
  // Phase 03.4-08: "+ Add data source" is now a modal mounted on /sources
  // instead of a hard navigate to /sources/new. The /sources/new route
  // still exists as a fallback (non-JS / direct-link entry).
  import AddSourceModal from "$lib/components/sources/AddSourceModal.svelte";
  import { SOURCE_PLATFORM_GROUPS, sourcePlatformGroupKey } from "$lib/sources/kind-display.js";
  import type { SourceKind } from "$lib/sources/adapter.js";
  import type { PageData } from "./$types";

  type DataSourceDto = {
    id: string;
    kind: SourceKind;
    handleUrl: string;
    displayName: string | null;
    note: string | null;
    isOwnedByMe: boolean;
    autoImport: boolean;
    deletedAt: Date | string | null;
    eventCount?: number;
  };

  let { data }: { data: PageData } = $props();

  // Trash view conditional — same pattern as /feed's trashView.
  let trashView = $derived(data.view === "trash");

  // Live refresh while any source has an active cooldown (worker is
  // processing a pull). Server loader re-runs every 3s; SourceRow updates
  // last_polled_at, event range, and the cooldown countdown without manual
  // page reload. Stops polling once all cooldowns hit 0.
  // Only active in live view — trash view has no cooldowns.
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    if (trashView) {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      return;
    }
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
  const totalEventCount = $derived(active.reduce((sum, s) => sum + (s.eventCount ?? 0), 0));

  // Group active sources by platform for the prototype-style
  // sources-group-head dividers. Grouping is DERIVED from the central
  // kind-display config (SOURCE_PLATFORM_GROUPS / sourcePlatformGroupKey):
  // reddit_account + reddit_subreddit share the "reddit" group key, and a
  // newly-added kind (instagram_account → "instagram") shows up automatically.
  // No silent default — every SourceKind maps to a group via the config's
  // `satisfies Record<SourceKind, …>` guarantee.
  type Group = {
    key: string;
    order: number;
    kind: SourceKind;
    label: string;
    items: DataSourceDto[];
  };
  const groups: Group[] = $derived.by(() => {
    const out: Group[] = [];
    const keyToGroup = new Map<string, Group>();
    for (const s of active) {
      const groupKey = sourcePlatformGroupKey(s.kind);
      let g = keyToGroup.get(groupKey);
      if (!g) {
        const def = SOURCE_PLATFORM_GROUPS.find((p) => p.key === groupKey)!;
        // Representative kind drives the group-head SourceKindIcon; the
        // first source's kind is representative of the group.
        g = { key: def.key, order: def.order, kind: s.kind, label: def.label, items: [] };
        keyToGroup.set(groupKey, g);
        out.push(g);
      }
      g.items.push(s);
    }
    // Sort groups by the config's platform order, stable across renders.
    return out.sort((a, b) => a.order - b.order);
  });

  let restoreError = $state<string | null>(null);

  // AddSourceModal open state.
  let addOpen = $state(false);

  // Collapsable group state.
  let collapsedGroups = $state<Set<string>>(new Set());
  $effect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem("sources.collapsedGroups");
      if (raw) collapsedGroups = new Set(JSON.parse(raw) as string[]);
    } catch {
      /* corrupt localStorage entry — ignore */
    }
  });
  function toggleGroup(label: string): void {
    const next = new Set(collapsedGroups);
    if (next.has(label)) {
      next.delete(label);
    } else {
      next.add(label);
    }
    collapsedGroups = next;
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("sources.collapsedGroups", JSON.stringify([...next]));
      } catch {
        /* quota / privacy mode — ignore */
      }
    }
  }

  // Toast state.
  let toast = $state<{ kind: "success" | "info" | "danger"; text: string } | null>(null);

  // Trash view: per-card Restore handler.
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
      toast = { kind: "success", text: m.toast_source_restored() };
      await invalidateAll();
    } catch {
      restoreError = m.error_network();
    }
  }

  // Trash view: Delete-forever state + confirm dialog.
  let deleteForeverId = $state<string | null>(null);
  let deleteForeverName = $state<string>("");
  let confirmDeleteForeverOpen = $state(false);

  function askDeleteForever(id: string, name: string): void {
    deleteForeverId = id;
    deleteForeverName = name;
    confirmDeleteForeverOpen = true;
  }

  async function confirmDeleteForever(): Promise<void> {
    if (!deleteForeverId) return;
    confirmDeleteForeverOpen = false;
    try {
      const res = await fetch(`/api/sources/${deleteForeverId}?force=true`, { method: "DELETE" });
      if (!res.ok) {
        toast = { kind: "danger", text: m.error_server_generic() };
        return;
      }
      toast = { kind: "success", text: m.toast_source_deleted_forever() };
      deleteForeverId = null;
      await invalidateAll();
    } catch {
      toast = { kind: "danger", text: m.error_network() };
    }
  }
</script>

<section class="sources">
  {#if trashView}
    <!-- Trash view — renders deleted sources as full SourceRow cards. -->
    <header class="page-head">
      <div class="page-head-row top">
        <div class="page-head-titlegroup">
          <h1 class="page-title">{m.sources_page_title_trash()}</h1>
        </div>
      </div>
    </header>

    <div class="trash-banner" role="status">
      <a class="trash-back" href="/sources">← {m.sources_trash_back()}</a>
      <span class="trash-banner-text"
        >{m.sources_trash_banner_text({ days: data.retentionDays })}</span
      >
    </div>

    {#if deleted.length === 0}
      <div class="trash-empty" role="status">
        <h2 class="trash-empty-heading">{m.sources_trash_empty_heading()}</h2>
        <p class="trash-empty-body">{m.sources_trash_empty_body({ days: data.retentionDays })}</p>
        <a href="/sources" class="trash-back-link">{m.sources_trash_back()}</a>
      </div>
    {:else}
      <div class="trash-list">
        {#each deleted as source (source.id)}
          <SourceRow
            {source}
            cooldownSec={0}
            pulling={false}
            view="trash"
            onRestore={() => restoreSource(source.id)}
            onDeleteForever={() =>
              askDeleteForever(source.id, source.displayName ?? source.handleUrl)}
          />
        {/each}
      </div>
    {/if}

    {#if restoreError}
      <InlineError message={restoreError} />
    {/if}
  {:else}
    <!-- Live view — normal sources page. -->
    <header class="page-head">
      <div class="page-head-row top">
        <div class="page-head-titlegroup">
          <h1 class="page-title">Sources</h1>
          <span class="page-head-summary">
            <span class="metric"><b>{active.length}</b> sources</span>
            <span class="metric"><b>{totalEventCount}</b> events</span>
          </span>
        </div>
        <button type="button" class="btn add-source" onclick={() => (addOpen = true)}>
          {m.sources_cta_new_source()}
        </button>
        {#if deleted.length > 0}
          <a class="recovery-link" href="/sources?view=trash">
            {m.page_header_recently_deleted({ count: deleted.length })}
          </a>
        {/if}
      </div>
    </header>

    <!-- Per-platform API quota banner. -->
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
        onCta={() => (addOpen = true)}
      />
    {:else}
      <div class="sources-list">
        {#each groups as group (group.label)}
          {@const expanded = !collapsedGroups.has(group.label)}
          <section class="sources-group" data-expanded={expanded ? "1" : "0"}>
            <button
              type="button"
              class="sources-group-head"
              onclick={() => toggleGroup(group.label)}
              aria-expanded={expanded}
            >
              <span class="sources-group-chev" aria-hidden="true">></span>
              <span class="kind-icon" aria-hidden="true" style="color: var(--k-{group.key});">
                <SourceKindIcon kind={group.kind} />
              </span>
              <h2 class="sources-group-title">{group.label}</h2>
              <span class="sources-group-count">{group.items.length}</span>
              <div class="sources-group-rule"></div>
            </button>
            {#if expanded}
              <div class="sources-rows">
                {#each group.items as source (source.id)}
                  <SourceRow
                    {source}
                    cooldownSec={data.cooldownBySource?.[source.id] ?? 0}
                    pulling={data.pullingBySource?.[source.id] ?? false}
                  />
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      </div>

      {#if restoreError}
        <InlineError message={restoreError} />
      {/if}
    {/if}
  {/if}

  <ConfirmDialog
    open={confirmDeleteForeverOpen}
    message={m.sources_trash_confirm_delete_forever({ name: deleteForeverName })}
    confirmLabel={m.sources_trash_delete_forever()}
    onConfirm={confirmDeleteForever}
    onCancel={() => (confirmDeleteForeverOpen = false)}
  />

  <!-- Add-source modal. /sources/new survives as a non-JS fallback. -->
  <AddSourceModal
    open={addOpen}
    kindMatrix={data.kindMatrix}
    socialBackfillMaxPosts={data.socialBackfillMaxPosts}
    defaultIsOwnedByMe={data.defaultIsOwnedByMe}
    defaultAutoImport={data.defaultAutoImport}
    onClose={() => (addOpen = false)}
  />

  {#if toast}
    <Toast kind={toast.kind} text={toast.text} onclose={() => (toast = null)} />
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
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-3);
    font-family: var(--f-mono);
    font-size: var(--t-12);
    font-variant-numeric: tabular-nums;
  }
  .page-head-summary .metric {
    display: inline-flex;
    align-items: baseline;
    gap: 3px;
  }
  .page-head-summary b {
    color: var(--text);
    font-weight: var(--w-sb);
  }

  .btn.add-source {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: var(--hit-lg);
    padding: 0 var(--s-4);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-md);
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .btn.add-source::first-letter {
    color: var(--accent);
    font-size: 1.25em;
    font-weight: var(--w-sb);
    margin-right: 4px;
    vertical-align: -1px;
  }
  .btn.add-source:hover {
    background: var(--surface-3, var(--surface-2));
    border-color: var(--accent);
  }
  .btn.add-source:hover::first-letter {
    color: var(--accent-strong);
  }
  .recovery-link {
    font-size: var(--t-13);
    color: var(--text-3);
    text-decoration: underline;
  }
  .recovery-link:hover {
    color: var(--accent);
  }

  /* Trash banner — ← back link left, then text. */
  .trash-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-2) var(--s-4);
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent-strong);
    border-radius: var(--r-sm);
    font-size: var(--t-13);
  }
  .trash-back {
    color: var(--accent-strong);
    text-decoration: none;
    font-weight: var(--w-sb);
    white-space: nowrap;
  }
  .trash-back:hover {
    text-decoration: underline;
  }
  .trash-banner-text {
    color: var(--accent);
  }

  /* Trash empty state. */
  .trash-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-3);
    padding: var(--s-8) var(--s-4);
    max-width: 560px;
    margin: 0 auto;
  }
  .trash-empty-heading {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    color: var(--text);
    letter-spacing: -0.01em;
    line-height: var(--lh-tight);
  }
  .trash-empty-body {
    margin: 0;
    color: var(--text-2);
    font-size: var(--t-14);
    line-height: var(--lh-body);
  }
  .trash-back-link {
    color: var(--accent);
    text-decoration: underline;
    font-size: var(--t-14);
    font-weight: var(--w-sb);
  }
  .trash-back-link:hover {
    color: var(--accent-strong);
  }

  /* Trash list — flex column of deleted SourceRow cards. */
  .trash-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding-bottom: var(--s-6);
  }

  /* Sources list — flex column of platform groups. */
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
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-3) 0;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .sources-group-head:hover .sources-group-title {
    color: var(--text);
  }
  .sources-group-chev {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    color: var(--accent);
    font-size: 16px;
    line-height: 1;
    transition: transform var(--m-fast) var(--m-ease);
    flex-shrink: 0;
  }
  .sources-group[data-expanded="1"] .sources-group-chev {
    transform: rotate(90deg);
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

  /* Group-head icon color is set inline via `style="color: var(--k-<key>)"`
   * (config-driven, keyed on the platform group key) so it stays correct no
   * matter which platforms the user has — the old `nth-of-type` rules
   * mis-colored when a platform group was absent. */

  .quota-disclosure {
    border: 1px solid var(--border-hairline);
    border-radius: var(--r-md);
    background: var(--surface);
    overflow: hidden;
    transition: border-color var(--m-fast) var(--m-ease);
  }
  .quota-disclosure[open] {
    border-color: var(--border);
  }
  .quota-disclosure > summary {
    padding: var(--s-2) var(--s-4);
    cursor: pointer;
    color: var(--text-3);
    font-size: var(--t-12);
    font-family: var(--f-mono);
    letter-spacing: 0.02em;
    text-transform: uppercase;
    font-weight: var(--w-sb);
    user-select: none;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 8px;
    transition: color var(--m-fast) var(--m-ease);
  }
  .quota-disclosure > summary::-webkit-details-marker {
    display: none;
  }
  .quota-disclosure > summary::before {
    content: ">";
    display: inline-flex;
    color: var(--accent);
    font-family: var(--f-sans);
    font-size: 14px;
    line-height: 1;
    transition: transform var(--m-fast) var(--m-ease);
    transform: rotate(0deg);
  }
  .quota-disclosure[open] > summary::before {
    transform: rotate(90deg);
  }
  .quota-disclosure > summary:hover {
    color: var(--text);
  }
  .quota-disclosure[open] > :not(summary) {
    padding: var(--s-3) var(--s-4) var(--s-4);
    border-top: 1px solid var(--border-hairline);
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
