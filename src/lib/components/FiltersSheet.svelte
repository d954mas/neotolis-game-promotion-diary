<script lang="ts">
  // FiltersSheet — mobile-only <dialog>-based bottom-sheet filter UX
  // (UI-SPEC §"Component inventory" + §"/feed filter row — chips → sheet
  // pattern"). Triggered by the FilterChips "Filters (N)" button below
  // 600px viewport.
  //
  // Native <dialog> + showModal() gives focus-trap + Esc-to-close out of
  // the box. Mirrors the ConfirmDialog pattern.
  //
  // Form controls (UI-SPEC):
  //   - <select> for source (data_source.id)
  //   - <select> for kind (eventKindEnum)
  //   - <select> for game
  //   - <input type="date"> for from / to
  //   - toggle pair for attached (true / false / any)
  //   - toggle pair for authorIsMe
  //
  // Footer: "Apply filters" (primary accent) + "Clear all filters" (secondary)
  // + neutral close (m.common_cancel()).

  import { m } from "$lib/paraglide/messages.js";

  type ActiveFilters = {
    source?: string;
    kind?: string;
    game?: string;
    attached?: boolean;
    authorIsMe?: boolean;
    from?: string;
    to?: string;
  };
  type SourceOption = { id: string; displayName: string | null; handleUrl: string };
  type GameOption = { id: string; title: string };

  let {
    filters,
    sources,
    games,
    onApply,
    onClose,
  }: {
    filters: ActiveFilters;
    sources: SourceOption[];
    games: GameOption[];
    onApply: (next: Record<string, string | boolean | undefined>) => void;
    onClose: () => void;
  } = $props();

  let dialogEl: HTMLDialogElement | null = $state(null);

  let source = $state(filters.source ?? "");
  let kind = $state(filters.kind ?? "");
  let game = $state(filters.game ?? "");
  let from = $state(filters.from ?? "");
  let to = $state(filters.to ?? "");
  let attached = $state<"any" | "true" | "false">(
    filters.attached === true ? "true" : filters.attached === false ? "false" : "any",
  );
  let authorIsMe = $state<"any" | "true" | "false">(
    filters.authorIsMe === true ? "true" : filters.authorIsMe === false ? "false" : "any",
  );

  $effect(() => {
    if (dialogEl && !dialogEl.open) {
      dialogEl.showModal();
    }
  });

  function onDialogCancel(e: Event): void {
    e.preventDefault();
    onClose();
  }

  function applyAll(): void {
    onApply({
      source: source === "" ? undefined : source,
      kind: kind === "" ? undefined : kind,
      game: game === "" ? undefined : game,
      attached: attached === "any" ? undefined : attached === "true",
      authorIsMe: authorIsMe === "any" ? undefined : authorIsMe === "true",
      from: from === "" ? undefined : from,
      to: to === "" ? undefined : to,
    });
  }

  function clearAll(): void {
    onApply({});
  }
</script>

<dialog
  bind:this={dialogEl}
  class="sheet"
  oncancel={onDialogCancel}
  aria-labelledby="filters-sheet-heading"
>
  <h2 id="filters-sheet-heading" class="heading">Filters</h2>

  <div class="grid">
    <label class="field">
      <span class="label">Source</span>
      <select class="input" bind:value={source}>
        <option value="">Any</option>
        {#each sources as s (s.id)}
          <option value={s.id}>{s.displayName ?? s.handleUrl}</option>
        {/each}
      </select>
    </label>

    <label class="field">
      <span class="label">Kind</span>
      <select class="input" bind:value={kind}>
        <option value="">Any</option>
        <option value="youtube_video">{m.event_kind_label_youtube_video()}</option>
        <option value="reddit_post">{m.event_kind_label_reddit_post()}</option>
        <option value="twitter_post">{m.event_kind_label_twitter_post()}</option>
        <option value="telegram_post">{m.event_kind_label_telegram_post()}</option>
        <option value="discord_drop">{m.event_kind_label_discord_drop()}</option>
        <option value="conference">{m.event_kind_label_conference()}</option>
        <option value="talk">{m.event_kind_label_talk()}</option>
        <option value="press">{m.event_kind_label_press()}</option>
        <option value="other">{m.event_kind_label_other()}</option>
      </select>
    </label>

    <label class="field">
      <span class="label">Game</span>
      <select class="input" bind:value={game}>
        <option value="">Any</option>
        {#each games as g (g.id)}
          <option value={g.id}>{g.title}</option>
        {/each}
      </select>
    </label>

    <fieldset class="field">
      <legend class="label">Attached</legend>
      <label class="toggle">
        <input type="radio" name="attached" value="any" bind:group={attached} /> Any
      </label>
      <label class="toggle">
        <input type="radio" name="attached" value="true" bind:group={attached} />
        {m.feed_filter_attached_true()}
      </label>
      <label class="toggle">
        <input type="radio" name="attached" value="false" bind:group={attached} />
        {m.feed_filter_attached_false()}
      </label>
    </fieldset>

    <fieldset class="field">
      <legend class="label">Author</legend>
      <label class="toggle">
        <input type="radio" name="author" value="any" bind:group={authorIsMe} /> Any
      </label>
      <label class="toggle">
        <input type="radio" name="author" value="true" bind:group={authorIsMe} />
        {m.feed_filter_author_me()}
      </label>
      <label class="toggle">
        <input type="radio" name="author" value="false" bind:group={authorIsMe} />
        {m.feed_filter_author_others()}
      </label>
    </fieldset>

    <label class="field">
      <span class="label">From</span>
      <input class="input" type="date" bind:value={from} />
    </label>
    <label class="field">
      <span class="label">To</span>
      <input class="input" type="date" bind:value={to} />
    </label>
  </div>

  <div class="actions">
    <button type="button" class="cancel" onclick={onClose}>
      {m.common_cancel()}
    </button>
    <button type="button" class="secondary" onclick={clearAll}>
      {m.feed_filters_clear_all()}
    </button>
    <button type="button" class="primary" onclick={applyAll}>
      {m.feed_filters_apply()}
    </button>
  </div>
</dialog>

<style>
  .sheet {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: var(--space-lg);
    width: min(560px, calc(100vw - 2 * var(--space-md)));
    max-height: 90vh;
    overflow-y: auto;
  }
  .sheet::backdrop {
    background: rgb(0 0 0 / 50%);
  }
  .heading {
    margin: 0 0 var(--space-md) 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .grid {
    display: grid;
    gap: var(--space-md);
    grid-template-columns: 1fr;
  }
  @media (min-width: 480px) {
    .grid {
      grid-template-columns: 1fr 1fr;
    }
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    border: none;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  .label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    font-weight: var(--font-weight-semibold);
  }
  .input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--font-size-label);
    min-height: 44px;
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    justify-content: flex-end;
    margin-top: var(--space-lg);
    flex-wrap: wrap;
  }
  .cancel,
  .secondary,
  .primary {
    min-height: 44px;
    padding: 0 var(--space-md);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .cancel,
  .secondary {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }
  .primary {
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
  }
</style>
