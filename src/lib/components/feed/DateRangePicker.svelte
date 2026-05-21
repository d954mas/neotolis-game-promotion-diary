<script lang="ts">
  // DateRangePicker — Wave 2a custom date-range dialog (Plan 03.4-07 Task 1).
  //
  // Verbatim port of docs/design/v2/ui-kit/app.jsx lines 394-762 to Svelte 5.
  // Three state machines from the prototype, preserved one-to-one:
  //
  //   1. level ∈ {"day", "month", "year"}  — drill-down navigation
  //   2. month (Date)                       — the displayed calendar's
  //                                           month/year anchor
  //   3. draft { from, to }                 — drag-select range; second
  //                                           click closes the range and
  //                                           lifts via onApply
  //
  // Engineering inversions vs. the prototype:
  //   - `today` is a prop (D-24 future-date guard) — never `new Date()` on
  //     the client. The SSR loader picks one instant and threads it
  //     through to every consumer; timezone drift between server-PT and
  //     client-UTC cannot pick a different "today".
  //   - Uses parseEventDate / startOfDay / fmtMonthDay from
  //     `$lib/feed/date-range.js` (Plan 03.4-02 Task 2) instead of
  //     duplicating those helpers inline.
  //   - Native HTML `<dialog>` element with `.showModal()` so the
  //     `html:has(dialog[open])` body-scroll-lock rule (LB-7) catches it
  //     automatically — no extra CSS plumbing per dialog.
  //   - Paraglide messages for every user-visible string (Plan 03.4-01).
  //
  // The custom inline native-date fallback (`<input type="date">`) lives
  // inside the .cal-input-row so the browser's date popup is reachable
  // via the absolutely-positioned overlay. We don't call showPicker()
  // programmatically — the native input itself receives clicks (it sits
  // on top of the text input area at the right edge).
  //
  // Layout pivot from prototype: in the prototype the picker is an
  // absolutely-positioned floating popover (anchored to the date chip).
  // The Svelte port uses a centered <dialog> instead — the native
  // <dialog>.showModal() behavior automatically draws a scrim, centers
  // the panel, and integrates with the LB-7 scroll-lock rule. The
  // prototype's anchorRect parameter is not ported (modal flow renders
  // visually closer to "I'm picking a range" intent than a floating
  // popover anchored to a chip).

  import { parseEventDate, startOfDay, fmtMonthDay } from "$lib/feed/date-range.js";
  import { m } from "$lib/paraglide/messages.js";

  let {
    value,
    open,
    anchorTop = 0,
    anchorLeft = 0,
    today,
    onApply,
    onClear,
    onClose,
  }: {
    value: { from: Date | null; to: Date | null } | null;
    open: boolean;
    anchorTop?: number;
    anchorLeft?: number;
    today: Date;
    onApply: (range: { from: Date; to: Date }) => void;
    onClear: () => void;
    onClose: () => void;
  } = $props();

  // Non-modal popover: handle click-outside + Esc manually since
  // dialog.show() doesn't render a scrim.
  $effect(() => {
    if (typeof window === "undefined") return;
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      const el = dialogEl;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) {
        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    // Defer one tick so the click that OPENED the picker doesn't immediately close it.
    const t = setTimeout(() => {
      document.addEventListener("click", handler, true);
      document.addEventListener("keydown", keyHandler);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", handler, true);
      document.removeEventListener("keydown", keyHandler);
    };
  });

  // ─── Date helpers (port-local, not exported) ─────────────────────────
  const WEEK_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ] as const;

  function toISO(d: Date): string {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }
  function sameDay(a: Date | null, b: Date | null): boolean {
    return !!a && !!b &&
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  }
  function monthMatrix(year: number, monthIdx: number): (Date | null)[] {
    // 6×7 grid of Date|null — Monday-first (offset = (getDay+6)%7).
    const first = new Date(year, monthIdx, 1);
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
    const cells: (Date | null)[] = [];
    for (let i = 0; i < 42; i++) {
      const dayNum = i - offset + 1;
      if (dayNum < 1 || dayNum > daysInMonth) cells.push(null);
      else cells.push(new Date(year, monthIdx, dayNum));
    }
    return cells;
  }

  // ─── Seeders — initial state on every open ───────────────────────────
  function seedDraft(): { from: Date | null; to: Date | null } {
    if (value && value.from && value.to) {
      return { from: startOfDay(value.from), to: startOfDay(value.to) };
    }
    return { from: null, to: null };
  }
  function seedMonth(): Date {
    if (value && value.from) {
      return new Date(value.from.getFullYear(), value.from.getMonth(), 1);
    }
    return new Date(today.getFullYear(), today.getMonth(), 1);
  }

  // ─── State ───────────────────────────────────────────────────────────
  const initialMonth = seedMonth();
  let month = $state<Date>(initialMonth);
  let draft = $state<{ from: Date | null; to: Date | null }>(seedDraft());
  let hover = $state<Date | null>(null);
  let level = $state<"day" | "month" | "year">("day");
  let decadeStart = $state<number>(Math.floor(initialMonth.getFullYear() / 10) * 10);
  let fromText = $state<string>("");
  let toText = $state<string>("");
  let fromInvalid = $state<boolean>(false);
  let toInvalid = $state<boolean>(false);

  let dialogEl: HTMLDialogElement | undefined = $state();

  // Open / close the native <dialog> in sync with the `open` prop. The
  // `.showModal()` API draws the scrim + locks focus; closing via the
  // ESC key triggers `cancel` which we forward to onClose().
  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    // Non-modal `.show()` so the picker behaves as a popover anchored to
    // the date-chip, not a centered modal. Matches prototype which uses
    // `position: fixed` with computed top/left from anchorRect.
    if (open && !el.open) el.show();
    if (!open && el.open) el.close();
  });

  // Whenever the dialog re-opens, reset state from the current value.
  $effect(() => {
    if (!open) return;
    const fresh = seedMonth();
    draft = seedDraft();
    month = fresh;
    hover = null;
    level = "day";
    decadeStart = Math.floor(fresh.getFullYear() / 10) * 10;
  });

  // Keep the YYYY-MM-DD text inputs synced to the draft state — without
  // this the inputs would show stale values after a calendar click.
  $effect(() => {
    fromText = draft.from ? toISO(draft.from) : "";
    toText = draft.to ? toISO(draft.to) : "";
    fromInvalid = false;
    toInvalid = false;
  });

  // ─── Range manipulation ──────────────────────────────────────────────
  function commitDateInput(which: "from" | "to", text: string): boolean {
    const t = text.trim();
    if (!t) {
      if (which === "from") draft = { ...draft, from: null };
      else draft = { ...draft, to: null };
      return true;
    }
    const parsed = parseEventDate(t);
    if (!parsed) return false;
    if (parsed > startOfDay(today)) return false; // D-24 future guard
    const s = startOfDay(parsed);
    if (which === "from") {
      if (draft.to && s > draft.to) draft = { from: draft.to, to: s };
      else draft = { ...draft, from: s };
      month = new Date(s.getFullYear(), s.getMonth(), 1);
    } else {
      if (draft.from && s < draft.from) draft = { from: s, to: draft.from };
      else draft = { ...draft, to: s };
      month = new Date(s.getFullYear(), s.getMonth(), 1);
    }
    return true;
  }
  function handleBlur(which: "from" | "to", text: string): void {
    const ok = commitDateInput(which, text);
    const invalid = !ok && text.trim() !== "";
    if (which === "from") {
      fromInvalid = invalid;
      if (invalid) fromText = draft.from ? toISO(draft.from) : "";
    } else {
      toInvalid = invalid;
      if (invalid) toText = draft.to ? toISO(draft.to) : "";
    }
  }

  function pickDay(d: Date): void {
    if (d > startOfDay(today)) return; // D-24 future-date guard
    let next: { from: Date | null; to: Date | null };
    if (!draft.from || (draft.from && draft.to)) {
      next = { from: d, to: null };
    } else {
      const from = draft.from;
      next = d < from ? { from: d, to: from } : { from, to: d };
    }
    draft = next;
    // Second click on a complete range = apply.
    if (next.from && next.to) onApply({ from: next.from, to: next.to });
  }

  function shiftMonth(delta: number): void {
    month = new Date(month.getFullYear(), month.getMonth() + delta, 1);
  }
  function jumpToMonth(monthIdx: number): void {
    month = new Date(month.getFullYear(), monthIdx, 1);
    level = "day";
  }
  function jumpToYear(year: number): void {
    month = new Date(year, month.getMonth(), 1);
    level = "month";
  }
  function handleNav(delta: number): void {
    if (level === "day") shiftMonth(delta);
    else if (level === "month") {
      month = new Date(month.getFullYear() + delta, month.getMonth(), 1);
    } else if (level === "year") {
      decadeStart = decadeStart + delta * 10;
    }
  }

  // ─── Derived for the current month grid ──────────────────────────────
  let y = $derived(month.getFullYear());
  let mo = $derived(month.getMonth());
  let cells = $derived(monthMatrix(y, mo));

  // Preview-range computation (hover overlay before the second click).
  let previewFrom = $derived(draft.from);
  let previewTo = $derived(
    draft.to ?? (previewFrom && hover && hover >= previewFrom ? hover : null),
  );
  let previewFromFinal = $derived(
    previewFrom && hover && !draft.to && hover < previewFrom ? hover : previewFrom,
  );
  let previewToFinal = $derived(
    !draft.to && hover && previewFrom && hover < previewFrom ? previewFrom : previewTo,
  );

  // Decade grid (12 cells: 1 outside + 10 in-range + 1 outside)
  let decadeYears = $derived(
    Array.from({ length: 12 }, (_, i) => decadeStart + i - 1),
  );
</script>

<dialog
  bind:this={dialogEl}
  class="date-range-picker"
  style="top: {anchorTop}px; left: {anchorLeft}px;"
  aria-label={m.feed_date_range_picker_close_aria()}
  oncancel={(e) => {
    e.preventDefault();
    onClose();
  }}
>
  <div
    class="panel"
    role="document"
  >
    <div class="cal-inputs">
      <label class="cal-input" data-invalid={fromInvalid ? "1" : "0"}>
        <span>{m.feed_date_range_picker_from()}</span>
        <div class="cal-input-row">
          <input
            type="text"
            inputmode="numeric"
            placeholder="YYYY-MM-DD"
            autocomplete="off"
            spellcheck="false"
            value={fromText}
            oninput={(e) => {
              fromText = e.currentTarget.value;
              fromInvalid = false;
            }}
            onblur={(e) => handleBlur("from", e.currentTarget.value)}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                handleBlur("from", e.currentTarget.value);
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                fromText = draft.from ? toISO(draft.from) : "";
                fromInvalid = false;
                e.currentTarget.blur();
              }
            }}
          />
          <input
            type="date"
            class="cal-input-native"
            max={toISO(today)}
            value={draft.from ? toISO(draft.from) : ""}
            onchange={(e) => commitDateInput("from", e.currentTarget.value)}
            tabindex={-1}
            aria-label="Open browser date picker for From"
          />
        </div>
      </label>
      <span class="cal-input-sep">→</span>
      <label class="cal-input" data-invalid={toInvalid ? "1" : "0"}>
        <span>{m.feed_date_range_picker_to()}</span>
        <div class="cal-input-row">
          <input
            type="text"
            inputmode="numeric"
            placeholder="YYYY-MM-DD"
            autocomplete="off"
            spellcheck="false"
            value={toText}
            oninput={(e) => {
              toText = e.currentTarget.value;
              toInvalid = false;
            }}
            onblur={(e) => handleBlur("to", e.currentTarget.value)}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                handleBlur("to", e.currentTarget.value);
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                toText = draft.to ? toISO(draft.to) : "";
                toInvalid = false;
                e.currentTarget.blur();
              }
            }}
          />
          <input
            type="date"
            class="cal-input-native"
            max={toISO(today)}
            value={draft.to ? toISO(draft.to) : ""}
            onchange={(e) => commitDateInput("to", e.currentTarget.value)}
            tabindex={-1}
            aria-label="Open browser date picker for To"
          />
        </div>
      </label>
    </div>

    <div class="cal-selection">
      {#if draft.from && draft.to}
        <span>
          <b>{fmtMonthDay(draft.from)}, {draft.from.getFullYear()}</b>
          <i>→</i>
          <b>{fmtMonthDay(draft.to)}, {draft.to.getFullYear()}</b>
        </span>
      {:else if draft.from}
        <span>
          <b>{fmtMonthDay(draft.from)}, {draft.from.getFullYear()}</b>
          <i>→ pick end date</i>
        </span>
      {:else}
        <span><i>Click a day to start</i></span>
      {/if}
    </div>

    <div class="cal-head">
      <button
        type="button"
        class="cal-nav"
        onclick={() => handleNav(-1)}
        aria-label="Previous"
      >‹</button>
      <div class="cal-head-tabs">
        <button
          type="button"
          class="cal-head-tab"
          data-active={level === "year" ? "1" : "0"}
          onclick={() => (level = level === "year" ? "day" : "year")}
        >
          {level === "year" ? `${decadeStart}–${decadeStart + 9}` : y}
        </button>
        <button
          type="button"
          class="cal-head-tab"
          data-active={level === "month" ? "1" : "0"}
          data-hidden={level === "year" ? "1" : "0"}
          onclick={() => (level = level === "month" ? "day" : "month")}
        >
          {MONTH_NAMES[mo]}
        </button>
      </div>
      <button
        type="button"
        class="cal-nav"
        onclick={() => handleNav(1)}
        aria-label="Next"
      >›</button>
    </div>

    {#if level === "year"}
      <div class="cal-coarse">
        <div class="cal-coarse-grid">
          {#each decadeYears as yr}
            {@const future = yr > today.getFullYear()}
            {@const outside = yr < decadeStart || yr > decadeStart + 9}
            <button
              type="button"
              class="cal-coarse-cell"
              data-outside={outside ? "1" : "0"}
              data-future={future ? "1" : "0"}
              data-current={yr === y ? "1" : "0"}
              disabled={future}
              onclick={() => !future && jumpToYear(yr)}
            >
              {yr}
            </button>
          {/each}
        </div>
      </div>
    {:else if level === "month"}
      <div class="cal-coarse">
        <div class="cal-coarse-grid">
          {#each MONTH_NAMES as name, idx}
            {@const future = new Date(y, idx, 1) > today}
            <button
              type="button"
              class="cal-coarse-cell"
              data-future={future ? "1" : "0"}
              data-current={idx === mo ? "1" : "0"}
              disabled={future}
              onclick={() => !future && jumpToMonth(idx)}
            >
              {name.slice(0, 3)}
            </button>
          {/each}
        </div>
      </div>
    {:else}
      <div class="cal-grid single">
        <div class="cal-month">
          <div class="cal-week-head">
            {#each WEEK_DAYS as w}
              <span>{w}</span>
            {/each}
          </div>
          <div class="cal-days">
            {#each cells as d, i (i)}
              {#if !d}
                <span class="cal-day empty"></span>
              {:else}
                {@const isFrom = sameDay(d, previewFromFinal)}
                {@const isTo = sameDay(d, previewToFinal)}
                {@const inRange =
                  !!previewFromFinal &&
                  !!previewToFinal &&
                  d > previewFromFinal &&
                  d < previewToFinal}
                {@const isToday = sameDay(d, today)}
                {@const future = d > startOfDay(today)}
                <button
                  type="button"
                  class="cal-day"
                  data-from={isFrom ? "1" : "0"}
                  data-to={isTo ? "1" : "0"}
                  data-in-range={inRange ? "1" : "0"}
                  data-today={isToday ? "1" : "0"}
                  data-future={future ? "1" : "0"}
                  disabled={future}
                  onclick={() => !future && pickDay(d)}
                  onmouseenter={() => (hover = d)}
                >
                  {d.getDate()}
                </button>
              {/if}
            {/each}
          </div>
        </div>
      </div>
    {/if}

    <div class="cal-actions">
      <button type="button" class="ghost" onclick={onClear}>
        {m.feed_date_range_picker_clear()}
      </button>
      <div style="flex: 1"></div>
      <button
        type="button"
        class="primary"
        disabled={!draft.from || !draft.to}
        onclick={() => {
          if (draft.from && draft.to) onApply({ from: draft.from, to: draft.to });
        }}
      >
        {m.feed_date_range_picker_apply()}
      </button>
    </div>
  </div>
</dialog>

<style>
  /* ─── Anchored popover — non-modal <dialog> positioned via inline
   * top/left from the date-chip's getBoundingClientRect (set by caller
   * DateRangeRow). Mirrors prototype `.date-picker`
   * (docs/design/v2/ui-kit/index.html lines 1145-1151). */
  .date-range-picker {
    position: fixed;
    z-index: 61;
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    max-width: calc(100vw - 32px);
    color: var(--text);
  }

  .panel {
    width: 340px;
    max-width: calc(100vw - 32px);
    background: var(--surface);
    border: 1px solid var(--border-2);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    padding: 12px 14px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* ─── Inputs ────────────────────────────────────────────────────── */
  .cal-inputs {
    display: flex;
    align-items: flex-end;
    gap: var(--s-2);
    padding: 2px 4px 8px;
    min-width: 0;
  }
  .cal-input {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    padding: 6px 10px 7px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    transition: border-color var(--m-fast) var(--m-ease);
    overflow: hidden;
  }
  .cal-input:focus-within {
    border-color: var(--accent);
  }
  .cal-input[data-invalid="1"] {
    border-color: var(--danger);
    background: color-mix(in oklab, var(--danger) 8%, var(--surface-2));
  }
  .cal-input > span {
    font-family: var(--f-mono, ui-monospace);
    font-size: 10px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    line-height: 1;
  }
  .cal-input input[type="text"] {
    width: 100%;
    min-width: 0;
    background: transparent;
    border: 0;
    color: var(--text);
    font: inherit;
    font-size: var(--t-13);
    font-variant-numeric: tabular-nums;
    outline: none;
    padding: 0 22px 0 0;
  }
  .cal-input-row {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
    min-width: 0;
  }
  .cal-input-row::after {
    content: "📅";
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    font-size: 13px;
    opacity: 0.7;
  }
  .cal-input-native {
    position: absolute;
    width: 22px;
    height: 22px;
    right: -2px;
    top: 50%;
    transform: translateY(-50%);
    opacity: 0;
    cursor: pointer;
    padding: 0;
    border: 0;
    background: transparent;
    z-index: 2;
  }
  .cal-input-sep {
    color: var(--text-3);
    font-size: 14px;
    flex-shrink: 0;
    padding-bottom: 10px;
  }

  /* ─── Selection summary ─────────────────────────────────────────── */
  .cal-selection {
    font-size: var(--t-13);
    color: var(--text-2);
    padding: 0 4px 4px;
    min-height: 18px;
  }
  .cal-selection b {
    color: var(--text);
    font-weight: var(--w-sb);
    font-variant-numeric: tabular-nums;
  }
  .cal-selection i {
    color: var(--text-3);
    font-style: normal;
    margin: 0 4px;
  }

  /* ─── Header / nav ───────────────────────────────────────────────── */
  .cal-head {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    padding: 0 4px 4px;
    border-bottom: 1px solid var(--border-hairline);
  }
  .cal-nav {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text-2);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    transition: border-color var(--m-fast) var(--m-ease), color var(--m-fast) var(--m-ease);
  }
  .cal-nav:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .cal-head-tabs {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
  }
  .cal-head-tab {
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    padding: 4px 10px;
    color: var(--text);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.005em;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .cal-head-tab:hover {
    background: var(--surface-2);
  }
  .cal-head-tab[data-active="1"] {
    background: var(--accent-soft);
    border-color: color-mix(in oklab, var(--accent) 40%, var(--border));
    color: var(--accent-strong);
  }
  .cal-head-tab[data-hidden="1"] {
    display: none;
  }

  /* ─── Day grid ───────────────────────────────────────────────────── */
  .cal-grid {
    padding: 4px;
  }
  .cal-grid.single .cal-month {
    padding: 0;
  }
  .cal-week-head {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
    margin-bottom: 4px;
  }
  .cal-week-head span {
    text-align: center;
    font-family: var(--f-mono, ui-monospace);
    font-size: 10.5px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 4px 0 6px;
  }
  .cal-days {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
  }
  .cal-day {
    aspect-ratio: 1 / 1;
    min-height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: var(--text);
    font-size: var(--t-13);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .cal-day:hover {
    background: var(--surface-2);
  }
  .cal-day.empty {
    visibility: hidden;
  }
  .cal-day[data-future="1"] {
    color: var(--text-3);
    opacity: 0.5;
    cursor: not-allowed;
  }
  .cal-day[data-future="1"]:hover {
    background: transparent;
  }
  .cal-day[data-today="1"] {
    color: var(--accent-strong);
    font-weight: var(--w-sb);
  }
  .cal-day[data-in-range="1"] {
    background: var(--accent-soft);
    color: var(--text);
    border-radius: 0;
  }
  .cal-day[data-from="1"],
  .cal-day[data-to="1"] {
    background: var(--accent);
    color: var(--accent-text);
    font-weight: var(--w-sb);
  }
  .cal-day[data-from="1"] {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .cal-day[data-to="1"] {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
  .cal-day[data-from="1"][data-to="1"] {
    border-radius: 6px;
  }

  /* ─── Coarse grids (month / year) ────────────────────────────────── */
  .cal-coarse {
    padding: 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-3);
  }
  .cal-coarse-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    width: 100%;
  }
  .cal-coarse-cell {
    padding: 12px 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    font-size: var(--t-13);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .cal-coarse-cell:hover {
    border-color: var(--accent);
  }
  .cal-coarse-cell[data-current="1"] {
    background: var(--accent-soft);
    border-color: color-mix(in oklab, var(--accent) 50%, var(--border));
    color: var(--accent-strong);
    font-weight: var(--w-sb);
  }
  .cal-coarse-cell[data-future="1"] {
    color: var(--text-3);
    opacity: 0.5;
    cursor: not-allowed;
    background: transparent;
  }
  .cal-coarse-cell[data-future="1"]:hover {
    border-color: var(--border);
  }
  .cal-coarse-cell[data-outside="1"] {
    background: transparent;
    color: var(--text-3);
  }

  /* ─── Actions ────────────────────────────────────────────────────── */
  .cal-actions {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: 8px 4px 0;
    border-top: 1px solid var(--border-hairline);
  }
  .cal-actions .ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 6px 12px;
    border-radius: var(--r-sm);
    font-size: var(--t-13);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .cal-actions .ghost:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .cal-actions .primary {
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    padding: 6px 14px;
    border-radius: var(--r-sm);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .cal-actions .primary:hover {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .cal-actions .primary:disabled {
    background: var(--surface-2);
    color: var(--text-3);
    border-color: var(--border);
    cursor: not-allowed;
  }

  @media (prefers-reduced-motion: reduce) {
    .cal-input,
    .cal-nav,
    .cal-head-tab,
    .cal-day,
    .cal-coarse-cell,
    .cal-actions .ghost,
    .cal-actions .primary {
      transition: none;
    }
  }
</style>
