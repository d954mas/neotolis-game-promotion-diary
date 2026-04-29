<script lang="ts">
  // /audit — read-only audit-log view (Plan 02-10; UX rewrite Plan 02.1-20).
  //
  // Plan 02.1-20: ActionFilter dropdown REMOVED. /audit reuses
  // <FilterChips> + <FiltersSheet> from /feed (Plan 02.1-19 reshape with
  // 'action' axis extension). Single-axis multi-select chip+sheet
  // pattern matches /feed's filter UX language.
  //
  // URL contract (Plan 02.1-20): ?action=A&action=B repeated params for
  // multi-select. No `?action=` params = all actions (default). Pre-
  // launch (CONTEXT D-04) — destructive change from previous
  // single-select `?action=A` is acceptable.
  //
  // Privacy review: loader gates anonymous users via early-return; the
  // listAuditPage call is userId-scoped (FIRST and-clause); DTO projection
  // strips userId; cross-tenant 404 not 403 holds via P19 (test asserts).

  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import AuditRow from "$lib/components/AuditRow.svelte";
  import FilterChips from "$lib/components/FilterChips.svelte";
  import FiltersSheet from "$lib/components/FiltersSheet.svelte";
  import CursorPager from "$lib/components/CursorPager.svelte";
  import type { PageData } from "./$types";

  type AuditEntryDtoLocal = {
    id: string;
    action: string;
    ipAddress: string;
    userAgent: string | null;
    metadata: unknown;
    createdAt: Date | string;
  };

  let { data }: { data: PageData } = $props();

  const rows = $derived(data.rows as unknown as AuditEntryDtoLocal[]);
  const nextCursor = $derived(data.nextCursor as string | null);
  const actionFilter = $derived((data.actionFilter as string[]) ?? []);

  let prevStack = $state<string[]>([]);
  let sheetOpen = $state(false);
  let sheetFocusAxis = $state<"action" | undefined>(undefined);

  // FilterChips + FiltersSheet expect ActiveFilters with the full /feed
  // shape. /audit only uses the action axis — pass empty arrays for
  // source/kind, show=any, no authorIsMe / from / to. The action axis is
  // the ONLY active surface (filters.action !== undefined enables it).
  const activeFilters = $derived({
    source: [] as string[],
    kind: [] as string[],
    show: { kind: "any" as const },
    defaultDateRange: false,
    all: actionFilter.length === 0,
    action: actionFilter,
  });

  function buildHref(cursor: string | null, nextActions: string[]): string {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    for (const a of nextActions) params.append("action", a);
    const qs = params.toString();
    return qs ? `/audit?${qs}` : "/audit";
  }

  async function onApply(next: { action?: string[] }): Promise<void> {
    sheetOpen = false;
    prevStack = [];
    const nextActions = next.action ?? [];
    await goto(buildHref(null, nextActions));
  }

  async function onDismissAxis(axis: string): Promise<void> {
    // /audit: only 'action' axis is dismissible; ignore others.
    if (axis !== "action") return;
    prevStack = [];
    await goto(buildHref(null, []));
  }

  async function onClearAll(): Promise<void> {
    prevStack = [];
    await goto(buildHref(null, []));
  }

  function onOpenSheet(focusAxis?: string): void {
    sheetFocusAxis = focusAxis === "action" ? "action" : undefined;
    sheetOpen = true;
  }

  async function onNext(): Promise<void> {
    if (!nextCursor) return;
    const current = page.url.searchParams.get("cursor");
    if (current) prevStack = [...prevStack, current];
    else prevStack = [...prevStack, ""];
    await goto(buildHref(nextCursor, actionFilter));
  }

  async function onPrev(): Promise<void> {
    if (prevStack.length === 0) return;
    const popped = prevStack[prevStack.length - 1]!;
    prevStack = prevStack.slice(0, -1);
    await goto(buildHref(popped === "" ? null : popped, actionFilter));
  }
</script>

<section class="audit">
  <header class="head">
    <h1>Audit log</h1>
  </header>

  <FilterChips
    filters={activeFilters}
    sources={[]}
    games={[]}
    onDismiss={onDismissAxis}
    onOpenSheet={onOpenSheet}
    onClearAll={onClearAll}
  />

  {#if sheetOpen}
    <FiltersSheet
      filters={activeFilters}
      sources={[]}
      games={[]}
      focusAxis={sheetFocusAxis}
      {onApply}
      onClose={() => (sheetOpen = false)}
    />
  {/if}

  {#if rows.length === 0}
    <EmptyState heading={m.empty_audit_heading()} body={m.empty_audit_body()} />
  {:else}
    <div class="rows">
      {#each rows as row (row.id)}
        <AuditRow entry={row} />
      {/each}
    </div>
    <CursorPager hasNext={nextCursor !== null} hasPrev={prevStack.length > 0} {onNext} {onPrev} />
  {/if}
</section>

<style>
  .audit {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    flex-wrap: wrap;
  }
  .head h1 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .rows {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
</style>
