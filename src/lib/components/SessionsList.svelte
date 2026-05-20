<script lang="ts">
  // SessionsList — active-sessions list for /settings.
  //
  // Layout:
  //   - one row per active session (timestamp + IP + abbreviated UA)
  //   - "Current session" badge on the row whose id === currentSessionId
  //   - "Sign out this session" button on every other row
  //   - empty case (only the current session): m.settings_sessions_only_current()
  //
  // Sign-out call: DELETE /api/sessions/:id → invalidate("/settings").
  //
  // Renders rows that look like AuditRow but are interactive.

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
      // Use invalidateAll() so every loader on /settings re-runs (the
      // page's +layout.server.ts sessions loader IS what populates this
      // list — a page-scoped invalidate would only re-run the page-level
      // loader, not the broader chain that supplies session data). After
      // the call SessionsList re-renders without the destroyed session.
      await invalidateAll();
    } catch {
      errorText = m.error_network();
    } finally {
      pendingId = null;
    }
  }

  // Empty case: only the current session is active.
  const onlyCurrent = $derived(sessions.length === 1 && sessions[0]?.id === currentSessionId);
</script>

{#if onlyCurrent}
  <p class="muted">{m.settings_sessions_only_current()}</p>
{:else}
  <ul class="sessions">
    {#each sessions as s (s.id)}
      <li class="session">
        <div class="meta">
          <time
            class="when"
            datetime={s.createdAt instanceof Date ? s.createdAt.toISOString() : s.createdAt}
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
  /* v2 SessionsList — D-01 redraw via AuditRow analogy. --surface-2
   * list-rows with --border-hairline separators. */
  .muted {
    margin: 0;
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-13);
  }
  .sessions {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .session {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-3) var(--s-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    flex-wrap: wrap;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    flex: 1 1 auto;
    min-width: 0;
  }
  .when {
    font-family: var(--f-sans);
    font-size: var(--t-13);
    color: var(--text);
  }
  .ip,
  .ua {
    font-family: var(--f-mono);
    font-size: var(--t-12);
    color: var(--text-3);
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: var(--s-2);
    align-items: center;
  }
  .current {
    font-family: var(--f-sans);
    font-size: var(--t-12);
    color: var(--text-3);
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: var(--s-0) var(--s-2);
  }
  .signout {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .signout:hover:not(:disabled) {
    background: var(--danger);
    color: #fff;
    border-color: var(--danger);
  }
  .signout:disabled {
    opacity: 0.55;
    cursor: progress;
  }
  @media (prefers-reduced-motion: reduce) {
    .signout {
      transition: none;
    }
  }
</style>
