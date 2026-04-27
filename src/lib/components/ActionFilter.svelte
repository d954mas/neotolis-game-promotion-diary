<script lang="ts">
  // ActionFilter — native <select> for filtering /audit by action. Options
  // are sourced from the closed AUDIT_ACTIONS list (D-32) plus an "All
  // actions" option that maps to value "all".
  //
  // The label for each option flows through Paraglide via the same
  // chip-mapping pattern as <AuditRow>. Selection fires onChange with the
  // raw value ("all" or one of AUDIT_ACTIONS).

  import { m } from "$lib/paraglide/messages.js";

  type ActionValue = "all" | string;

  let {
    value,
    onChange,
  }: {
    value: ActionValue;
    onChange: (v: ActionValue) => void;
  } = $props();

  // Mirror AUDIT_ACTIONS from src/lib/server/audit/actions.ts. Duplicated
  // here so this client-side component doesn't reach into server modules.
  // The i18n.test invariant catches any drift in label keys; the
  // anonymous-401 + cross-tenant tests catch any drift in server values.
  const options: ReadonlyArray<{ value: string; label: () => string }> = [
    { value: "all", label: () => m.audit_action_all() },
    { value: "session.signin", label: () => m.audit_action_session_signin() },
    { value: "session.signout", label: () => m.audit_action_session_signout() },
    { value: "session.signout_all", label: () => m.audit_action_session_signout_all() },
    { value: "key.add", label: () => m.audit_action_key_add() },
    { value: "key.rotate", label: () => m.audit_action_key_rotate() },
    { value: "key.remove", label: () => m.audit_action_key_remove() },
    { value: "game.created", label: () => m.audit_action_game_created() },
    { value: "game.deleted", label: () => m.audit_action_game_deleted() },
    { value: "game.restored", label: () => m.audit_action_game_restored() },
    { value: "item.created", label: () => m.audit_action_item_created() },
    { value: "item.deleted", label: () => m.audit_action_item_deleted() },
    { value: "event.created", label: () => m.audit_action_event_created() },
    { value: "event.edited", label: () => m.audit_action_event_edited() },
    { value: "event.deleted", label: () => m.audit_action_event_deleted() },
    { value: "theme.changed", label: () => m.audit_action_theme_changed() },
  ];
</script>

<label class="filter">
  <span class="label">Filter</span>
  <select
    class="select"
    {value}
    onchange={(e) => onChange((e.currentTarget as HTMLSelectElement).value)}
  >
    {#each options as opt}
      <option value={opt.value}>{opt.label()}</option>
    {/each}
  </select>
</label>

<style>
  .filter {
    display: inline-flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .select {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
  }
</style>
