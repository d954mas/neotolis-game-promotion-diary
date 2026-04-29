<script lang="ts">
  // SessionsList — active-sessions list for /settings (Plan 02.1-09).
  //
  // UI-SPEC §"/settings (EXTENDED — sessions list + theme blurb)":
  //   - one row per active session (timestamp + IP + abbreviated UA)
  //   - "Current session" badge on the row whose id === currentSessionId
  //   - "Sign out this session" button on every other row
  //   - empty case (only the current session): m.settings_sessions_only_current()
  //
  // Sign-out call: DELETE /api/sessions/:id → invalidate("/settings"). The
  // route lands in the same plan (02.1-09 routes/sessions.ts).
  //
  // Renders rows that look like AuditRow but are interactive (UI-SPEC).

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "./InlineError.svelte";

  type SessionDto = {
    id: string;
    expiresAt: Date | string;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date | string;
  };

  let {
    sessions,
    currentSessionId,
  }: {
    sessions: SessionDto[];
    currentSessionId: string;
  } = $props();

  let pendingId = $state<string | null>(null);
  let errorText = $state<string | null>(null);

  function abbreviateUa(ua: string | null): string {
    if (!ua) return "Unknown device";
    return ua.length <= 60 ? ua : `${ua.slice(0, 57)}…`;
  }

  function fmtTimestamp(ts: Date | string): string {
    const d = ts instanceof Date ? ts : new Date(ts);
    return d.toLocaleString();
  }

  async function signOutOne(id: string): Promise<void> {
    if (pendingId) return;
    pendingId = id;
    errorText = null;
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        errorText = m.error_server_generic();
        return;
      }
      // Plan 02.1-22 (UAT-NOTES.md §6.3-bug closure): use invalidateAll() so
      // every loader on /settings re-runs (the page's +layout.server.ts
      // sessions loader IS what populates this list — the previous
      // invalidate("/settings") only invalidated the page-level loader, not
      // the broader chain that supplies session data). After the call
      // SessionsList re-renders without the destroyed session.
      await invalidateAll();
    } catch {
      errorText = m.error_network();
    } finally {
      pendingId = null;
    }
  }

  // Empty case: only the current session is active.
  const onlyCurrent = $derived(
    sessions.length === 1 && sessions[0]?.id === currentSessionId,
  );
</script>

{#if onlyCurrent}
  <p class="muted">{m.settings_sessions_only_current()}</p>
{:else}
  <ul class="sessions">
    {#each sessions as s (s.id)}
      <li class="session">
        <div class="meta">
          <time class="when" datetime={s.createdAt instanceof Date ? s.createdAt.toISOString() : s.createdAt}
            >{fmtTimestamp(s.createdAt)}</time
          >
          <span class="ip">{s.ipAddress ?? "Unknown IP"}</span>
          <span class="ua">{abbreviateUa(s.userAgent)}</span>
        </div>
        <div class="actions">
          {#if s.id === currentSessionId}
            <span class="current">{m.settings_sessions_current_badge()}</span>
          {:else}
            <button
              type="button"
              class="signout"
              onclick={() => signOutOne(s.id)}
              disabled={pendingId === s.id}
            >
              {m.settings_sessions_signout_one()}
            </button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
  {#if errorText}<InlineError message={errorText} />{/if}
{/if}

<style>
  .muted {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .sessions {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .session {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    flex-wrap: wrap;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    flex: 1 1 auto;
    min-width: 0;
  }
  .when {
    font-size: var(--font-size-label);
    color: var(--color-text);
  }
  .ip,
  .ua {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    font-family: var(--font-family-mono);
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    align-items: center;
  }
  .current {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 2px var(--space-sm);
  }
  .signout {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    cursor: pointer;
  }
  .signout:hover:not(:disabled) {
    color: var(--color-destructive);
    border-color: var(--color-destructive);
  }
  .signout:disabled {
    opacity: 0.5;
    cursor: progress;
  }
</style>
