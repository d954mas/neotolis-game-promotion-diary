<script lang="ts">
  // /audit — read-only audit-log view (Plan 02-10, PRIV-02).
  //
  // <ActionFilter> top + stack of <AuditRow> + <CursorPager> bottom. The
  // cursor + action live in the URL query string so the browser back/forward
  // stack reflects pagination state. "← Newer" pops the previous-cursor
  // stack we maintain client-side (the API doesn't return prevCursor;
  // cursor pagination is forward-only by design — D-31).

  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import AuditRow from "$lib/components/AuditRow.svelte";
  import ActionFilter from "$lib/components/ActionFilter.svelte";
  import CursorPager from "$lib/components/CursorPager.svelte";
  import type { PageData } from "./$types";

  type AuditEntryDtoLocal = {
    id: string;
    action: string;
    ipAddress: string;
    userAgent: string | null;
    metadata: unknown;
    createdAt: string;
  };

  let { data }: { data: PageData } = $props();

  const rows = $derived(data.rows as AuditEntryDtoLocal[]);
  const nextCursor = $derived(data.nextCursor as string | null);
  const action = $derived((data.action as string) ?? "all");

  // Maintain a back-stack of cursors client-side (sessionStorage would also
  // work; component-local state is enough for a single browser tab).
  let prevStack = $state<string[]>([]);

  function buildHref(cursor: string | null, nextAction: string): string {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (nextAction && nextAction !== "all") params.set("action", nextAction);
    const qs = params.toString();
    return qs ? `/audit?${qs}` : "/audit";
  }

  async function onActionChange(v: string): Promise<void> {
    prevStack = [];
    await goto(buildHref(null, v));
  }

  async function onNext(): Promise<void> {
    if (!nextCursor) return;
    const current = page.url.searchParams.get("cursor");
    if (current) prevStack = [...prevStack, current];
    else prevStack = [...prevStack, ""];
    await goto(buildHref(nextCursor, action));
  }

  async function onPrev(): Promise<void> {
    if (prevStack.length === 0) return;
    const popped = prevStack[prevStack.length - 1]!;
    prevStack = prevStack.slice(0, -1);
    await goto(buildHref(popped === "" ? null : popped, action));
  }
</script>

<section class="audit">
  <header class="head">
    <h1>Audit log</h1>
    <ActionFilter value={action} onChange={onActionChange} />
  </header>

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
