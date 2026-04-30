<script lang="ts">
  // /audit — read-only audit-log view (Plan 02-10; UX rewrite Plan 02.1-20;
  // schema-prop reshape + date-range filter Plan 02.1-21).
  //
  // Plan 02.1-20: ActionFilter dropdown REMOVED. /audit reuses
  // <FilterChips> + <FiltersSheet> from /feed (Plan 02.1-19 reshape).
  //
  // Plan 02.1-21 (round-3 UAT closure for §9.2-bug):
  //   - schema={['action','date']} replaces Plan 02.1-20's implicit
  //     filters.action-detection. /feed-only axes (kind / source / show /
  //     authorIsMe) cannot leak into the FiltersSheet or chip strip.
  //   - <DateRangeControl> ABOVE the chip strip mirrors /feed layout
  //     (UAT user quote: "В окне аудита нет возможности выбрать дату как
  //     в feed").
  //   - URL contract: ?from=YYYY-MM-DD&to=YYYY-MM-DD (mirrors /feed).
  //     UNLIKE /feed, no default 30-day window — auditing is investigative.
  //
  // URL contract (Plan 02.1-20): ?action=A&action=B repeated params for
  // multi-select. No `?action=` params = all actions (default).
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
  import DateRangeControl from "$lib/components/DateRangeControl.svelte";
  import CursorPager from "$lib/components/CursorPager.svelte";
  // Plan 02.1-39 (UAT-NOTES.md §5.7): /audit gains the shared sticky
  // PageHeader so its title row stays pinned under AppHeader on scroll —
  // matches /feed, /games, /sources for cross-page consistency.
  import PageHeader from "$lib/components/PageHeader.svelte";
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
  const fromIso = $derived((data.from as string | undefined) ?? undefined);
  const toIso = $derived((data.to as string | undefined) ?? undefined);

  // Plan 02.1-21: schema is the authoritative list of axes /audit owns.
  // FiltersSheet renders only these; FilterChips emits chips only for these.
  //
  // Plan 02.1-34 (UAT-NOTES.md §4.21.A): 'date' axis REMOVED from /audit's
  // schema. The page-level <DateRangeControl> above <FilterChips> stays as
  // the single source of truth for date filtering on /audit. Plan 02.1-21
  // shipped both the page-level DateRangeControl AND the in-sheet date
  // axis; round-4 UAT surfaced the duplication ("Дублируется выбор даты —
  // и в date-range-control, и в окне фильтров"). The /feed schema KEEPS
  // 'date' in the sheet (no duplication on /feed by design — there the
  // sheet date axis is the secondary entry the user actively wants).
  const AUDIT_SCHEMA = ["action"] as const;

  let prevStack = $state<string[]>([]);
  let sheetOpen = $state(false);
  let sheetFocusAxis = $state<"action" | "date" | undefined>(undefined);

  // FilterChips + FiltersSheet expect ActiveFilters with the full /feed
  // shape. /audit owns only the 'action' + 'date' axes — pass empty
  // arrays for source/kind, show=any, no authorIsMe. The schema prop
  // (passed below) is what controls per-axis rendering, not the field
  // values themselves (Plan 02.1-21 reshape).
  const activeFilters = $derived({
    source: [] as string[],
    kind: [] as string[],
    show: { kind: "any" as const },
    from: fromIso,
    to: toIso,
    defaultDateRange: false,
    all: actionFilter.length === 0 && fromIso === undefined && toIso === undefined,
    action: actionFilter,
  });

  function buildHref(
    cursor: string | null,
    nextActions: string[],
    nextFrom: string | undefined,
    nextTo: string | undefined,
  ): string {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    for (const a of nextActions) params.append("action", a);
    if (nextFrom) params.set("from", nextFrom);
    if (nextTo) params.set("to", nextTo);
    const qs = params.toString();
    return qs ? `/audit?${qs}` : "/audit";
  }

  async function onApply(next: { action?: string[]; from?: string; to?: string }): Promise<void> {
    sheetOpen = false;
    prevStack = [];
    const nextActions = next.action ?? actionFilter;
    // Sheet's date axis: empty string in either field clears it. Plan
    // 02.1-21 schema-respecting clearAll sends from/to as undefined.
    const nextFrom = next.from || undefined;
    const nextTo = next.to || undefined;
    await goto(buildHref(null, nextActions, nextFrom, nextTo));
  }

  async function onDismissAxis(axis: string): Promise<void> {
    // /audit: only 'action' axis is chip-dismissible. Date axis is
    // managed by <DateRangeControl> above the chip strip (no chip).
    if (axis !== "action") return;
    prevStack = [];
    await goto(buildHref(null, [], fromIso, toIso));
  }

  async function onClearAll(): Promise<void> {
    prevStack = [];
    await goto(buildHref(null, [], undefined, undefined));
  }

  function onOpenSheet(focusAxis?: string): void {
    sheetFocusAxis = focusAxis === "action" ? "action" : focusAxis === "date" ? "date" : undefined;
    sheetOpen = true;
  }

  // Plan 02.1-21: dedicated handler for the always-visible <DateRangeControl>.
  // The control emits { from, to } (preset / inputs) or { all: true } (× clear).
  async function applyDateRangeAudit(next: {
    from?: string;
    to?: string;
    all?: boolean;
  }): Promise<void> {
    prevStack = [];
    if (next.all) {
      await goto(buildHref(null, actionFilter, undefined, undefined));
      return;
    }
    await goto(buildHref(null, actionFilter, next.from, next.to));
  }

  async function onNext(): Promise<void> {
    if (!nextCursor) return;
    const current = page.url.searchParams.get("cursor");
    if (current) prevStack = [...prevStack, current];
    else prevStack = [...prevStack, ""];
    await goto(buildHref(nextCursor, actionFilter, fromIso, toIso));
  }

  async function onPrev(): Promise<void> {
    if (prevStack.length === 0) return;
    const popped = prevStack[prevStack.length - 1]!;
    prevStack = prevStack.slice(0, -1);
    await goto(buildHref(popped === "" ? null : popped, actionFilter, fromIso, toIso));
  }
</script>

<section class="audit">
  <PageHeader title="Audit log" sticky />

  <DateRangeControl {activeFilters} onApply={applyDateRangeAudit} />

  <FilterChips
    filters={activeFilters}
    sources={[]}
    games={[]}
    schema={AUDIT_SCHEMA}
    onDismiss={onDismissAxis}
    {onOpenSheet}
    {onClearAll}
  />

  {#if sheetOpen}
    <FiltersSheet
      filters={activeFilters}
      sources={[]}
      games={[]}
      schema={AUDIT_SCHEMA}
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
  /* Plan 02.1-39 (UAT-NOTES.md §5.7): inline .head + .head h1 styles
   * removed — replaced by the shared <PageHeader sticky> at the top of the
   * page. PageHeader owns the title font-size + sticky offset; .audit only
   * needs the column layout for the rest of the page chrome. */
  .rows {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
</style>
