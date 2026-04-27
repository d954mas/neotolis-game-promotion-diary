<script lang="ts">
  // RetentionBadge — displays "Purges in N days" for soft-deleted rows
  // (D-25). Computes daysUntilPurge = (deletedAt + retentionDays - now)
  // and renders the warning variant (destructive color) when fewer than
  // 7 days remain — gives the user a chance to restore before the cron
  // permanently purges.
  //
  // retentionDays is a prop so the page can pass the env-derived value
  // without this component reading process.env (CLAUDE.md hard rule).

  import { m } from "$lib/paraglide/messages.js";

  let {
    deletedAt,
    retentionDays = 60,
    now = new Date(),
  }: {
    deletedAt: Date | string;
    retentionDays?: number;
    now?: Date;
  } = $props();

  const daysUntilPurge = $derived.by((): number => {
    const deleted = typeof deletedAt === "string" ? new Date(deletedAt) : deletedAt;
    const purgeAt = deleted.getTime() + retentionDays * 24 * 60 * 60 * 1000;
    const ms = purgeAt - now.getTime();
    return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  });

  const isWarning = $derived(daysUntilPurge < 7);
</script>

<span class="badge" class:warning={isWarning}>
  {#if isWarning}
    {m.badge_purge_in_days_warning({ days: daysUntilPurge })}
  {:else}
    {m.badge_purge_in_days({ days: daysUntilPurge })}
  {/if}
</span>

<style>
  .badge {
    display: inline-block;
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 2px var(--space-sm);
  }
  .warning {
    color: var(--color-destructive);
    border-color: var(--color-destructive);
  }
</style>
