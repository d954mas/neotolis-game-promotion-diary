<script lang="ts">
  // AuditRow — single row in the /audit page list (PRIV-02). Stacked layout
  // on mobile, table-row on desktop. Renders the action chip via a
  // Paraglide picker over the closed-list audit_log.action enum, plus
  // metadata.last4 / metadata.kind for key.* events.
  //
  // The `action` value is one of AUDIT_ACTIONS (src/lib/server/audit/actions.ts).
  // We accept it as a string here so this component doesn't have to import
  // the server-side type — the chip-mapping function below covers every
  // closed-list value and falls back to the raw string for forward
  // compatibility.

  import { m } from "$lib/paraglide/messages.js";

  type AuditEntry = {
    id: string;
    action: string;
    ipAddress: string;
    userAgent: string | null;
    metadata: unknown;
    createdAt: Date | string;
  };

  let { entry }: { entry: AuditEntry } = $props();

  function chipLabel(action: string): string {
    switch (action) {
      case "session.signin":
        return m.audit_action_session_signin();
      case "session.signout":
        return m.audit_action_session_signout();
      case "session.signout_all":
        return m.audit_action_session_signout_all();
      case "key.add":
        return m.audit_action_key_add();
      case "key.rotate":
        return m.audit_action_key_rotate();
      case "key.remove":
        return m.audit_action_key_remove();
      case "game.created":
        return m.audit_action_game_created();
      case "game.deleted":
        return m.audit_action_game_deleted();
      case "game.restored":
        return m.audit_action_game_restored();
      case "item.created":
        return m.audit_action_item_created();
      case "item.deleted":
        return m.audit_action_item_deleted();
      case "event.created":
        return m.audit_action_event_created();
      case "event.edited":
        return m.audit_action_event_edited();
      case "event.deleted":
        return m.audit_action_event_deleted();
      case "theme.changed":
        return m.audit_action_theme_changed();
      default:
        return action;
    }
  }

  const isKeyAction = $derived(entry.action.startsWith("key."));
  const meta = $derived(entry.metadata as Record<string, unknown> | null);
  const last4 = $derived(
    isKeyAction && meta && typeof meta["last4"] === "string" ? (meta["last4"] as string) : null,
  );

  const occurredIso = $derived(
    typeof entry.createdAt === "string" ? entry.createdAt : entry.createdAt.toISOString(),
  );
  const occurredHuman = $derived(
    typeof entry.createdAt === "string"
      ? new Date(entry.createdAt).toLocaleString()
      : entry.createdAt.toLocaleString(),
  );
  const ua = $derived(entry.userAgent ?? "—");
</script>

<div class="row">
  <time class="when" datetime={occurredIso} title={occurredIso}>{occurredHuman}</time>
  <span class="chip">{chipLabel(entry.action)}</span>
  {#if last4}
    <code class="last4">••••••••{last4}</code>
  {/if}
  <span class="ip">{entry.ipAddress}</span>
  <span class="ua">{ua}</span>
</div>

<style>
  .row {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-xs);
    padding: var(--space-md);
    border-bottom: 1px solid var(--color-border);
  }
  .when {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .chip {
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-muted);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 2px var(--space-sm);
    align-self: flex-start;
    width: fit-content;
  }
  .last4 {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-label);
    color: var(--color-text);
  }
  .ip {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    font-family: var(--font-family-mono);
  }
  .ua {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    word-break: break-word;
  }
  @media (min-width: 768px) {
    .row {
      grid-template-columns: 200px auto auto 1fr 1fr;
      align-items: center;
      gap: var(--space-md);
    }
  }
</style>
