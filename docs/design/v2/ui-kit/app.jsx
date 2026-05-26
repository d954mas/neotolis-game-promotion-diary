// Neotolis v2 feed — App shell + page composition.
// Imports KindIcon, KIND_INFO, GAMES, EVENTS, gameById, groupedEvents, fmt
// from window (app-data.jsx loads first).

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "vibe": "warm",
  "accent": "amber",
  "density": "regular",
  "kindColor": true,
  "theme": "dark",
  "detailStyle": "panel"
}/*EDITMODE-END*/;

// Accent swatch palettes (only for the "Warm diary" base; Linear and Stripe
// vibes use the accent token too but their card border/fill stays cool).
const ACCENT_PALETTES = {
  amber:  { val: "#E89B5E", strong: "#F3AE73", soft: "rgba(232,155,94,.14)",  ink: "#0E0E10" },
  coral:  { val: "#E07377", strong: "#EE8B8E", soft: "rgba(224,115,119,.14)", ink: "#0E0E10" },
  sage:   { val: "#7FB46A", strong: "#94C880", soft: "rgba(127,180,106,.14)", ink: "#0E0E10" },
  plum:   { val: "#B488D4", strong: "#C8A3E3", soft: "rgba(180,136,212,.16)", ink: "#1C1320" },
};

function Brand() {
  // Tiny pixel-style mark — 3x3 grid lit with the accent. Reads as a friendly
  // mascot at 24×24 without being a literal sprite.
  return (
    <div className="brand-mark" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 9 9">
        <rect x="0" y="0" width="3" height="3" fill="currentColor" opacity="0.85"/>
        <rect x="3" y="0" width="3" height="3" fill="currentColor" opacity="0.55"/>
        <rect x="0" y="3" width="3" height="3" fill="currentColor" opacity="0.65"/>
        <rect x="6" y="3" width="3" height="3" fill="currentColor" opacity="0.95"/>
        <rect x="3" y="6" width="3" height="3" fill="currentColor" opacity="0.40"/>
      </svg>
    </div>
  );
}

function Chrome({ vibe, currentTab, onSwitchTab }) {
  const tabs = [
    { key: "feed",     label: "Feed",     icon: I.feed     },
    { key: "sources",  label: "Sources",  icon: I.sources  },
    { key: "games",    label: "Games",    icon: I.games    },
    { key: "settings", label: "Settings", icon: I.settings },
    { key: "about",    label: "About",    icon: I.info     },
  ];
  return (
    <div className="chrome">
      <div className="topbar">
        <a href="#" className="brand">
          <Brand/>
          <span>Promotion diary</span>
        </a>
        <nav className="nav-tabs">
          {tabs.map((t) => (
            <a
              key={t.key}
              href={"#/" + t.key}
              className={currentTab === t.key ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                onSwitchTab?.(t.key);
              }}
            >
              {t.icon}
              <span>{t.label}</span>
            </a>
          ))}
        </nav>
        <button className="userchip" aria-label="Account menu">
          <span className="avatar">A</span>
          <span className="uname">adventpixel</span>
          <span className="chev">{I.chev}</span>
        </button>
      </div>
    </div>
  );
}

function PageHead({
  view, onSwitchView,
  onAdd, onOpenRecovery, deletedCount,
  onRestoreAll, onEmptyTrash,
  query, onQuery, filtersOpen, onToggleFilters, activeFilterCount,
  filteredCount, totalCount,
  // Date scope props — rendered as a third floor right under the H1
  // since "when" is the first decision before "what / who / where".
  dateRange, onChangeDateRange, sortDir, onToggleSort,
}) {
  const isFiltered = filteredCount != null && totalCount != null && filteredCount !== totalCount;
  const inTrash = view === "trash";
  return (
    <header className="page-head">
      {/* Floor 1 — display row. Title group on the left, actions to the
        * right of it. Count summary lives ABSOLUTELY under the H1, so its
        * length doesn't affect layout. CTA cluster swaps based on view. */}
      <div className="page-head-row top">
        <div className="page-head-titlegroup">
          <h1 className="page-title">{inTrash ? "Recently deleted" : "Feed"}</h1>
          {totalCount != null ? (
            <span className="page-head-summary" aria-label="Event count">
              {isFiltered ? (
                <><b>{filteredCount}</b> of <b>{totalCount}</b> {inTrash ? "items" : "events"}</>
              ) : (
                <><b>{totalCount}</b> {inTrash ? "items" : "events"}</>
              )}
              {inTrash ? (
                <><span className="sep">·</span>auto-removed in 30 days</>
              ) : null}
            </span>
          ) : null}
        </div>

        {inTrash ? (
          <>
            {/* Back-to-Feed sits in the slot Add-event normally occupies
              * so the "primary action of this view" lives in the same
              * spot users already trained on.
              *
              * No "Restore all" / "Empty trash" buttons here on purpose:
              * destructive and bulk-restore actions should require an
              * intentional path (check items → bulk-bar, or per-card ⋯).
              * A single page-level button is too easy to mis-click. */}
            <button
              className="btn add-event"
              onClick={() => onSwitchView("feed")}
              title="Back to Feed"
            >
              {I.arrowLeft}<span>Back to Feed</span>
            </button>
          </>
        ) : (
          <>
            <button className="btn add-event" onClick={onAdd}>
              {I.plus}<span>Add event</span>
            </button>
            {deletedCount > 0 ? (
              <button
                className="btn-link recovery-link"
                onClick={() => onSwitchView("trash")}
              >
                Recently deleted ({deletedCount})
              </button>
            ) : null}
          </>
        )}
      </div>

      {/* Floor 2 — date scope: "when am I looking at". Reads as the
        * first filter decision, before search/filters. */}
      <DateRangeRow
        active={dateRange}
        onChange={onChangeDateRange}
        sortDir={sortDir}
        onToggleSort={onToggleSort}
      />

      {/* Floor 3 — utility row: search + filters */}
      <div className="page-head-row utility">
        <div className="page-head-search">
          {I.search}
          <input
            placeholder={inTrash ? "Search trash…" : "Search events…"}
            value={query ?? ""}
            onChange={(e) => onQuery(e.target.value)}
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onQuery("")}
              className="page-head-search-x"
            >×</button>
          ) : null}
        </div>

        <button
          type="button"
          className="btn ghost filters-toggle"
          data-active={activeFilterCount > 0 ? "1" : "0"}
          onClick={onToggleFilters}
          aria-expanded={filtersOpen}
        >
          {I.filter}
          <span>Filters</span>
          {activeFilterCount > 0 ? (
            <span className="filters-count">{activeFilterCount}</span>
          ) : null}
          <span className="filters-chev" data-open={filtersOpen ? "1" : "0"}>{I.chev}</span>
        </button>
      </div>
    </header>
  );
}

// Compact strip shown when filters are collapsed but some are active.
// Each chip uses the same color treatment as the filter chip it represents
// (Inbox is accent, Game is game-color, Kind has its kind color).
// Clicking the × dismisses just that filter.
function ActiveFiltersStrip({ show, game, author, activeKinds, onClearShow, onClearGame, onClearAuthor, onClearKind, onClearAll }) {
  const chips = [];
  if (show !== "all") {
    chips.push({
      key: "show", label: "Inbox", variant: "show",
      clear: onClearShow,
    });
  }
  for (const v of game) {
    if (v === "off_topic") {
      chips.push({ key: "game:ot", label: "Off topic", variant: "game", clear: () => onClearGame(v) });
    } else {
      const g = gameById[v];
      chips.push({
        key: "game:" + v,
        label: g?.title ?? v,
        variant: "game",
        color: g?.color,
        clear: () => onClearGame(v),
      });
    }
  }
  if (author !== "anyone") {
    chips.push({
      key: "author", variant: "author",
      label: author === "mine" ? "Mine" : "Others",
      clear: onClearAuthor,
    });
  }
  for (const k of activeKinds) {
    chips.push({
      key: "kind:" + k, variant: "kind",
      label: KIND_INFO[k].label, kind: k,
      color: KIND_INFO[k].color,
      clear: () => onClearKind(k),
    });
  }
  if (chips.length === 0) return null;
  return (
    <div className="active-filters">
      {chips.map((c) => (
        <button
          key={c.key}
          className="chip active-chip"
          data-variant={c.variant}
          style={c.color ? { "--card-accent": c.color } : null}
          onClick={c.clear}
        >
          {c.kind ? <span className="kind-icon"><KindIcon kind={c.kind} size={14}/></span> : null}
          <span>{c.label}</span>
          <span className="x" aria-hidden="true">×</span>
        </button>
      ))}
      <button className="btn-link" onClick={onClearAll}>Clear all</button>
    </div>
  );
}

// Generic axis row — uniform pattern for every filter axis. Single-axis
// radio: pick one. Multi-axis (Kind): pick many; tap "All" to clear.
function AxisRow({ label, value, options, onChange, multi = false, count, continuation = false }) {
  function isActive(opt) {
    if (multi) {
      if (opt.value == null) return !value || value.length === 0;
      return Array.isArray(value) && value.includes(opt.value);
    }
    return value === opt.value;
  }
  function click(opt) {
    if (!multi) {
      onChange(opt.value);
      return;
    }
    if (opt.value == null) return onChange([]);
    const next = Array.isArray(value) ? value : [];
    onChange(next.includes(opt.value) ? next.filter((x) => x !== opt.value) : [...next, opt.value]);
  }
  return (
    <div className={"axis-row" + (continuation ? " axis-row-cont" : "")}>
      <span className="axis-label">{label}</span>
      <div className="axis-chips">
        {options.map((opt) => (
          <button
            key={opt.key}
            className={"chip axis-chip" + (opt.kind ? " kind-chip" : "") + (opt.gameId ? " game-chip" : "")}
            data-active={isActive(opt) ? "1" : "0"}
            data-key={opt.key}
            data-empty={opt.count === 0 ? "1" : "0"}
            style={opt.kind ? { "--card-accent": KIND_INFO[opt.kind].color } : opt.gameId ? { "--card-accent": gameById[opt.gameId]?.color } : null}
            onClick={() => click(opt)}
          >
            {opt.kind ? (
              <span className="kind-icon">
                <KindIcon kind={opt.kind} size={18}/>
              </span>
            ) : null}
            {opt.gameId ? <span className="game-dot"/> : null}
            <span>{opt.label}</span>
            {opt.count != null ? <span className="axis-chip-count">{opt.count}</span> : null}
          </button>
        ))}
        {count != null ? <span className="axis-row-meta">{count}</span> : null}
      </div>
    </div>
  );
}

// ─── Date filtering ──────────────────────────────────────────────────────────
// Today is hardcoded to match the prototype's mock data (event dates run
// May 12 backward into March). All event date strings are "Mon DD" without
// year — we assume current year, rolling back to last year if the month
// is in the future relative to today.
const TODAY = new Date(2026, 4, 14); // May 14, 2026 (month is 0-indexed)
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseEventDate(s) {
  if (!s) return null;
  const [mon, dayStr] = s.split(" ");
  const m = MONTHS[mon];
  if (m == null) return null;
  let year = TODAY.getFullYear();
  if (m > TODAY.getMonth()) year -= 1;
  return new Date(year, m, parseInt(dayStr, 10));
}
function fmtMonthDay(d) {
  if (!d) return "";
  const mon = Object.keys(MONTHS)[d.getMonth()];
  return `${mon} ${d.getDate()}`;
}
// Returns the [from, to] window for a preset OR a custom {from, to} object.
function dateRangeWindow(value) {
  if (!value || value === "all") return null;
  // Custom range — both endpoints are real Date objects.
  if (typeof value === "object" && value.from && value.to) {
    const from = new Date(value.from); from.setHours(0, 0, 0, 0);
    const to   = new Date(value.to);   to.setHours(23, 59, 59, 999);
    return [from, to];
  }
  const to = TODAY;
  const from = new Date(TODAY);
  if (value === "today") {
    /* same day */
  } else if (value === "week") {
    from.setDate(from.getDate() - 6);   // 7 days inclusive
  } else if (value === "month") {
    from.setDate(from.getDate() - 29);  // 30 days inclusive
  } else if (value === "year") {
    from.setFullYear(from.getFullYear() - 1);
    from.setDate(from.getDate() + 1);
  }
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  return [from, to];
}
function dateInRange(eventDateStr, value) {
  const win = dateRangeWindow(value);
  if (!win) return true;
  const d = parseEventDate(eventDateStr);
  if (!d) return true;
  return d >= win[0] && d <= win[1];
}
function isCustomRange(v) {
  return v && typeof v === "object" && v.from && v.to;
}

// ─── Date range picker ─────────────────────────────────────────────────────
// Two-month calendar popover with drag-select. Click on a day = picks
// "from"; second click (or drag end) = picks "to". Hovering after the
// first click previews the range. Apply commits the range to the parent.
const WEEK_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function toISO(d) {
  // YYYY-MM-DD in local time — what <input type="date"> expects.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function sameDay(a, b) { return a && b && a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
function monthMatrix(year, month) {
  // Returns 6×7 array of Date|null for the given month — Monday-first.
  const first = new Date(year, month, 1);
  // JS getDay: 0=Sun..6=Sat; want Mon=0..Sun=6
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const dayNum = i - offset + 1;
    if (dayNum < 1 || dayNum > daysInMonth) cells.push(null);
    else cells.push(new Date(year, month, dayNum));
  }
  return cells;
}

function DateRangePicker({ open, anchorRect, value, onApply, onClose }) {
  // Seed the draft from whatever's currently active.
  function seedDraft() {
    if (isCustomRange(value)) {
      return { from: startOfDay(value.from), to: startOfDay(value.to) };
    }
    const win = dateRangeWindow(value);
    if (win) return { from: startOfDay(win[0]), to: startOfDay(win[1]) };
    return { from: null, to: null };
  }
  function seedMonth() {
    if (isCustomRange(value)) return new Date(value.from.getFullYear(), value.from.getMonth(), 1);
    const win = dateRangeWindow(value);
    if (win) return new Date(win[0].getFullYear(), win[0].getMonth(), 1);
    return new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
  }

  const [month, setMonth] = React.useState(seedMonth);
  const [draft, setDraft] = React.useState(seedDraft);
  const [hover, setHover] = React.useState(null);
  // Drill-down level: "day" = month grid (default), "month" = pick a
  // month of the current year, "year" = pick a year from a decade grid.
  const [level, setLevel] = React.useState("day");
  const [decadeStart, setDecadeStart] = React.useState(() =>
    Math.floor(month.getFullYear() / 10) * 10
  );
  // Text inputs as plain <input type="text"> with YYYY-MM-DD format.
  // We do NOT commit on every keystroke — only on blur or Enter — so
  // partial typing like "2" never collapses to "0002" or "1901". The
  // user can fully type "2026-04-16" then leave the field to apply.
  const [fromText, setFromText] = React.useState("");
  const [toText, setToText]     = React.useState("");
  const [fromInvalid, setFromInvalid] = React.useState(false);
  const [toInvalid, setToInvalid]     = React.useState(false);

  React.useEffect(() => {
    setFromText(draft.from ? toISO(draft.from) : "");
    setToText(draft.to     ? toISO(draft.to)   : "");
    setFromInvalid(false);
    setToInvalid(false);
  }, [draft.from, draft.to]);

  function commitDateInput(which, text) {
    const t = text.trim();
    if (!t) {
      // Empty = clear that endpoint
      if (which === "from") setDraft({ ...draft, from: null });
      else setDraft({ ...draft, to: null });
      return true;
    }
    const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) return false;
    const yr = +m[1], mo = +m[2], da = +m[3];
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return false;
    const d = new Date(yr, mo - 1, da);
    if (d.getFullYear() !== yr || d.getMonth() !== mo - 1 || d.getDate() !== da) return false;
    if (d > startOfDay(TODAY)) return false;
    const s = startOfDay(d);
    if (which === "from") {
      if (draft.to && s > draft.to) setDraft({ from: draft.to, to: s });
      else setDraft({ ...draft, from: s });
      setMonth(new Date(s.getFullYear(), s.getMonth(), 1));
    } else {
      if (draft.from && s < draft.from) setDraft({ from: s, to: draft.from });
      else setDraft({ ...draft, to: s });
      setMonth(new Date(s.getFullYear(), s.getMonth(), 1));
    }
    return true;
  }
  function handleBlur(which, text) {
    const ok = commitDateInput(which, text);
    const invalid = !ok && text.trim() !== "";
    if (which === "from") {
      setFromInvalid(invalid);
      // Invalid — revert text to the last good value so the calendar
      // and downstream filtering never see garbage.
      if (invalid) setFromText(draft.from ? toISO(draft.from) : "");
    } else {
      setToInvalid(invalid);
      if (invalid) setToText(draft.to ? toISO(draft.to) : "");
    }
  }

  React.useEffect(() => {
    if (!open) return;
    const fresh = seedMonth();
    setDraft(seedDraft());
    setMonth(fresh);
    setHover(null);
    setLevel("day");
    setDecadeStart(Math.floor(fresh.getFullYear() / 10) * 10);
  }, [open, value]);

  if (!open) return null;

  const previewFrom = draft.from;
  const previewTo = draft.to ?? (previewFrom && hover && hover >= previewFrom ? hover : null);
  const previewFromFinal = previewFrom && hover && !draft.to && hover < previewFrom ? hover : previewFrom;
  const previewToFinal = !draft.to && hover && previewFrom && hover < previewFrom ? previewFrom : previewTo;

  function pickDay(d) {
    let next;
    if (!draft.from || (draft.from && draft.to)) {
      next = { from: d, to: null };
    } else {
      const from = draft.from;
      next = d < from ? { from: d, to: from } : { from, to: d };
    }
    setDraft(next);
    // Only commit when the range is COMPLETE (from + to). First click
    // sets the anchor; second click closes the range and applies. This
    // way users can pick a real range without the popover treating each
    // click as a single-day commit.
    if (next.from && next.to) onApply({ from: next.from, to: next.to });
  }

  // Commit text/native-picker inputs and live-apply.
  function applyEndpoint(which, d) {
    const s = startOfDay(d);
    let next;
    if (which === "from") {
      next = (draft.to && s > draft.to) ? { from: draft.to, to: s } : { ...draft, from: s };
    } else {
      next = (draft.from && s < draft.from) ? { from: s, to: draft.from } : { ...draft, to: s };
    }
    setDraft(next);
    setMonth(new Date(s.getFullYear(), s.getMonth(), 1));
    if (next.from && next.to) onApply({ from: next.from, to: next.to });
    else if (next.from) onApply({ from: next.from, to: next.from });
  }

  function shiftMonth(delta) {
    setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
  }
  function jumpToMonth(monthIdx) {
    setMonth(new Date(month.getFullYear(), monthIdx, 1));
    setLevel("day");
  }
  function jumpToYear(year) {
    setMonth(new Date(year, month.getMonth(), 1));
    setLevel("month");
  }

  function handleNav(delta) {
    if (level === "day")   shiftMonth(delta);
    if (level === "month") setMonth(new Date(month.getFullYear() + delta, month.getMonth(), 1));
    if (level === "year")  setDecadeStart(decadeStart + delta * 10);
  }

  const y = month.getFullYear(), mo = month.getMonth();
  const cells = monthMatrix(y, mo);

  const style = anchorRect ? {
    top:  anchorRect.bottom + 8,
    left: Math.max(16, Math.min(anchorRect.left, window.innerWidth - 340)),
  } : { top: 80, left: 80 };

  function renderLevel() {
    if (level === "year") {
      const years = [];
      for (let i = -1; i < 11; i++) years.push(decadeStart + i);
      return (
        <div className="cal-coarse">
          <div className="cal-coarse-grid">
            {years.map((yr) => {
              const future = yr > TODAY.getFullYear();
              const outside = yr < decadeStart || yr > decadeStart + 9;
              return (
                <button
                  key={yr}
                  type="button"
                  className="cal-coarse-cell"
                  data-outside={outside ? "1" : "0"}
                  data-future={future ? "1" : "0"}
                  data-current={yr === y ? "1" : "0"}
                  disabled={future}
                  onClick={() => !future && jumpToYear(yr)}
                >
                  {yr}
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    if (level === "month") {
      return (
        <div className="cal-coarse">
          <div className="cal-coarse-grid">
            {MONTH_NAMES.map((name, idx) => {
              const future = new Date(y, idx, 1) > TODAY;
              return (
                <button
                  key={name}
                  type="button"
                  className="cal-coarse-cell"
                  data-future={future ? "1" : "0"}
                  data-current={idx === mo ? "1" : "0"}
                  disabled={future}
                  onClick={() => !future && jumpToMonth(idx)}
                >
                  {name.slice(0, 3)}
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    // Default: day calendar
    return (
      <div className="cal-grid single">
        <div className="cal-month">
          <div className="cal-week-head">
            {WEEK_DAYS.map((w) => <span key={w}>{w}</span>)}
          </div>
          <div className="cal-days">
            {cells.map((d, i) => {
              if (!d) return <span key={i} className="cal-day empty"/>;
              const isFrom = sameDay(d, previewFromFinal);
              const isTo   = sameDay(d, previewToFinal);
              const inRange = previewFromFinal && previewToFinal &&
                d > previewFromFinal && d < previewToFinal;
              const isToday = sameDay(d, TODAY);
              const future = d > startOfDay(TODAY);
              return (
                <button
                  type="button"
                  key={i}
                  className="cal-day"
                  data-from={isFrom ? "1" : "0"}
                  data-to={isTo ? "1" : "0"}
                  data-in-range={inRange ? "1" : "0"}
                  data-today={isToday ? "1" : "0"}
                  data-future={future ? "1" : "0"}
                  disabled={future}
                  onClick={() => !future && pickDay(d)}
                  onMouseEnter={() => setHover(d)}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="picker-scrim" onClick={onClose}/>
      <div className="date-picker simple" role="dialog" aria-label="Pick a date range" style={style}>
        {/* Plain text inputs in YYYY-MM-DD. Unlike <input type="date">,
          * these don't auto-pad partial years or commit on every keystroke
          * — user types the full date, then blur/Enter applies it. Invalid
          * input flags the field red but doesn't destroy what was there.
          * The calendar-icon button on the right opens the browser's
          * native date picker via showPicker() for users who want click
          * instead of typing. */}
        <div className="cal-inputs">
          <label className="cal-input" data-invalid={fromInvalid ? "1" : "0"}>
            <span>From</span>
            <div className="cal-input-row">
              <input
                type="text"
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                autoComplete="off"
                spellCheck="false"
                value={fromText}
                onChange={(e) => { setFromText(e.target.value); setFromInvalid(false); }}
                onBlur={(e) => handleBlur("from", e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { handleBlur("from", e.target.value); e.target.blur(); }
                  if (e.key === "Escape") { setFromText(draft.from ? toISO(draft.from) : ""); setFromInvalid(false); e.target.blur(); }
                }}
              />
              <input
                type="date"
                className="cal-input-native"
                max={toISO(TODAY)}
                value={draft.from ? toISO(draft.from) : ""}
                onChange={(e) => commitDateInput("from", e.target.value)}
                tabIndex={-1}
                aria-label="Open browser date picker for From"
              />
            </div>
          </label>
          <span className="cal-input-sep">→</span>
          <label className="cal-input" data-invalid={toInvalid ? "1" : "0"}>
            <span>To</span>
            <div className="cal-input-row">
              <input
                type="text"
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                autoComplete="off"
                spellCheck="false"
                value={toText}
                onChange={(e) => { setToText(e.target.value); setToInvalid(false); }}
                onBlur={(e) => handleBlur("to", e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { handleBlur("to", e.target.value); e.target.blur(); }
                  if (e.key === "Escape") { setToText(draft.to ? toISO(draft.to) : ""); setToInvalid(false); e.target.blur(); }
                }}
              />
              <input
                type="date"
                className="cal-input-native"
                max={toISO(TODAY)}
                value={draft.to ? toISO(draft.to) : ""}
                onChange={(e) => commitDateInput("to", e.target.value)}
                tabIndex={-1}
                aria-label="Open browser date picker for To"
              />
            </div>
          </label>
        </div>

        {/* Selection summary — shows what's currently picked. */}
        <div className="cal-selection">
          {draft.from && draft.to ? (
            <span><b>{fmtMonthDay(draft.from)}, {draft.from.getFullYear()}</b> <i>→</i> <b>{fmtMonthDay(draft.to)}, {draft.to.getFullYear()}</b></span>
          ) : draft.from ? (
            <span><b>{fmtMonthDay(draft.from)}, {draft.from.getFullYear()}</b> <i>→ pick end date</i></span>
          ) : (
            <span><i>Click a day to start</i></span>
          )}
        </div>

        {/* Year ▸ Month ▸ Calendar — clickable header lets the user jump
          * between the three drill-down levels without ever touching a
          * native date input (which has clumsy typing UX for years). */}
        <div className="cal-head">
          <button className="cal-nav" onClick={() => handleNav(-1)} aria-label="Previous">‹</button>
          <div className="cal-head-tabs">
            <button
              type="button"
              className="cal-head-tab"
              data-active={level === "year" ? "1" : "0"}
              onClick={() => setLevel(level === "year" ? "day" : "year")}
            >
              {level === "year" ? `${decadeStart}–${decadeStart + 9}` : y}
            </button>
            <button
              type="button"
              className="cal-head-tab"
              data-active={level === "month" ? "1" : "0"}
              data-hidden={level === "year" ? "1" : "0"}
              onClick={() => setLevel(level === "month" ? "day" : "month")}
            >
              {MONTH_NAMES[mo]}
            </button>
          </div>
          <button className="cal-nav" onClick={() => handleNav(1)} aria-label="Next">›</button>
        </div>

        {renderLevel()}

        <div className="cal-actions">
          <div style={{ flex: 1 }}/>
          <button className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}

function DateRangeRow({ active, onChange, sortDir, onToggleSort }) {
  const presets = [
    { key: "all",   label: "All time" },
    { key: "year",  label: "Year" },
    { key: "month", label: "Month" },
    { key: "week",  label: "Week" },
    { key: "today", label: "Today" },
  ];
  const isCustom = isCustomRange(active);
  const win = dateRangeWindow(active);
  const rangeLabel = isCustom
    ? `${fmtMonthDay(active.from)} — ${fmtMonthDay(active.to)}`
    : win
      ? (active === "today" ? fmtMonthDay(TODAY) : `${fmtMonthDay(win[0])} — ${fmtMonthDay(win[1])}`)
      : "All time";
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [anchorRect, setAnchorRect] = React.useState(null);
  return (
    <div className="axis-row" data-no-label="1">
      <div className="axis-chips">
        <button
          className="btn ghost date-chip"
          data-custom={isCustom ? "1" : "0"}
          style={{ height: 32, minHeight: 32, fontSize: 13, whiteSpace: "nowrap", flexShrink: 0 }}
          onClick={(e) => {
            setAnchorRect(e.currentTarget.getBoundingClientRect());
            setPickerOpen(true);
          }}
          title="Pick a custom range"
        >
          {I.cal}<span>{rangeLabel}</span>
        </button>
        {presets.map((p) => (
          <button
            key={p.key}
            className="chip axis-chip"
            data-active={!isCustom && active === p.key ? "1" : "0"}
            onClick={() => onChange(p.key)}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className="btn ghost sort-toggle"
          onClick={onToggleSort}
          title="Toggle sort order"
        >
          {sortDir === "desc" ? "↓" : "↑"}
          <span>{sortDir === "desc" ? "Newest first" : "Oldest first"}</span>
        </button>
      </div>

      <DateRangePicker
        open={pickerOpen}
        anchorRect={anchorRect}
        value={active}
        onApply={(range) => onChange(range)}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}

// FindRow — text-search axis. Applies AFTER all other filters; searches
// the already-narrowed visible set so the result count below matches.
function FindRow({ value, onChange, resultCount, hasOtherFilters }) {
  return (
    <div className="axis-row" data-no-label="1">
      <div className="axis-chips">
        <div className="search-local">
          {I.search}
          <input
            placeholder="Search in current view…"
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
          {value ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onChange("")}
              style={{
                background: "transparent", border: 0, color: "var(--text-3)",
                width: 20, height: 20, borderRadius: "50%",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 14, cursor: "pointer",
              }}
            >×</button>
          ) : null}
        </div>
        {value ? (
          <span className="find-result">
            {resultCount} match{resultCount === 1 ? "" : "es"}
            {hasOtherFilters ? " in current filters" : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function DateGroupHeader({ label, count }) {
  return (
    <div className="date-head">
      <h2>{label}</h2>
      <span className="count">{count}</span>
      <div className="rule"/>
    </div>
  );
}

// Games picker — multi-edit with tri-state checkboxes.
//
// State per game (and per off-topic flag): "on" | "off" | "mixed".
//   - on    = all targeted events have this attached → checkbox checked
//   - off   = none of the targeted events have it    → unchecked
//   - mixed = some have, some don't                  → indeterminate
//
// Click cycles between on ↔ off; the "mixed" state only appears as the
// initial value when bulk-editing a set of events with different states.
// Once the user has touched a row it can't return to "mixed" (only
// pressing Cancel restores the original mixed view).
//
// Apply contract — for each event in the selection:
//   - games with state="on":    add if not present
//   - games with state="off":   remove if present
//   - games with state="mixed": leave alone (untouched)
function GamesPicker({ open, anchorRect, initialGameStates, initialOffTopicState, count, onApply, onClose }) {
  const [gameStates, setGameStates] = React.useState(() => new Map(Object.entries(initialGameStates ?? {})));
  const [offTopicState, setOffTopicState] = React.useState(initialOffTopicState ?? "off");

  React.useEffect(() => {
    setGameStates(new Map(Object.entries(initialGameStates ?? {})));
    setOffTopicState(initialOffTopicState ?? "off");
  }, [initialGameStates, initialOffTopicState, open]);

  if (!open) return null;

  function cycle(state) {
    // mixed → on; on → off; off → on
    if (state === "mixed") return "on";
    if (state === "on")    return "off";
    return "on";
  }
  function toggleGame(id) {
    const next = new Map(gameStates);
    next.set(id, cycle(next.get(id) ?? "off"));
    setGameStates(next);
  }
  function toggleOffTopic() {
    setOffTopicState(cycle(offTopicState));
  }

  function apply() {
    onApply({
      gameStates: Object.fromEntries(gameStates),
      offTopicState,
    });
  }

  const style = anchorRect ? {
    top:  anchorRect.bottom + 8,
    left: Math.min(anchorRect.left, window.innerWidth - 320),
  } : {};

  function renderCheck(state) {
    return (
      <span className="picker-check" data-state={state}>
        {state === "on"    ? I.check : null}
        {state === "mixed" ? <span className="picker-check-dash"/> : null}
      </span>
    );
  }

  return (
    <>
      <div className="picker-scrim" onClick={onClose}/>
      <div className="picker" role="dialog" aria-label="Games and topics" style={style}>
        <div className="picker-head">
          <span>{count > 1 ? `Edit ${count} events` : "Games"}</span>
          <button className="picker-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="picker-options">
          {GAMES.map((g) => {
            const state = gameStates.get(g.id) ?? "off";
            return (
              <button
                key={g.id}
                className="picker-opt"
                data-state={state}
                onClick={() => toggleGame(g.id)}
              >
                {renderCheck(state)}
                <span className="picker-game-dot" style={{ background: g.color }}/>
                <span className="picker-label">{g.title}</span>
              </button>
            );
          })}
        </div>

        <div className="picker-sep"/>

        <button
          className="picker-opt"
          data-state={offTopicState}
          onClick={toggleOffTopic}
        >
          {renderCheck(offTopicState)}
          <span className="picker-game-dot dashed"/>
          <span className="picker-label">Off topic</span>
          <span className="picker-hint">flag · can coexist with games</span>
        </button>

        <div className="picker-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={apply}>Apply</button>
        </div>
      </div>
    </>
  );
}

// Sticky bottom bar shown when mass-select has 1+ events checked.
// Actions adapt to scope: feed has Games + Delete; trash has Restore +
// Delete forever.
function BulkActionBar({ count, mode = "feed", onOpenPicker, onDelete, onRestore, onClear }) {
  if (count === 0) return null;
  const inTrash = mode === "trash";
  return (
    <div className="bulk-bar" role="region" aria-label="Bulk actions">
      <div className="bulk-bar-inner">
        <span className="bulk-count">
          <strong>{count}</strong> selected
        </span>
        {inTrash ? (
          <button className="btn ghost" onClick={onRestore}>
            {I.restore}<span>Restore</span>
          </button>
        ) : (
          <button className="btn ghost" onClick={onOpenPicker}>
            {I.games}<span>Games</span>
          </button>
        )}
        <button className="btn ghost danger" onClick={onDelete}>
          {I.trash}<span>{inTrash ? "Delete forever" : "Delete"}</span>
        </button>
        <div style={{ flex: 1 }}/>
        <button className="btn-link" onClick={onClear}>Clear selection</button>
      </div>
    </div>
  );
}

function FeedCard({ event, kindColored, selected, view = "feed", onToggleSelect, onOpenPicker, onOpenMenu, onOpenDetail, onDelete, anySelected }) {
  const info = KIND_INFO[event.kind] ?? KIND_INFO.other;
  const games = (event.gameIds ?? []).map((id) => gameById[id]).filter(Boolean);

  // Slot order: meta → title → content → footer.
  const isMediaKind = event.kind === "youtube_video";
  const showThumb = !!event.thumb || isMediaKind;

  const style = { "--card-accent": info.color };
  const [hovered, setHovered] = React.useState(false);

  // Long-press → enter selection mode. ~480ms; cancelled on move/scroll.
  const pressTimer = React.useRef(null);
  function startPress(e) {
    cancelPress();
    const target = e.currentTarget;
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      try { navigator.vibrate?.(15); } catch {}
      target.dataset.longPressed = "1";
      onToggleSelect(event.id, true);
    }, 480);
  }
  function cancelPress() {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
  }

  return (
    <article
      className="card"
      data-kind-color={kindColored ? "1" : "0"}
      data-media={showThumb ? "1" : "0"}
      data-selected={selected ? "1" : "0"}
      data-view={view}
      style={style}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); cancelPress(); }}
      onMouseDown={startPress}
      onMouseUp={cancelPress}
      onTouchStart={startPress}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onClick={(e) => {
        if (e.target.closest(".card-actions, .card-menu, .card-select")) return;
        if (e.currentTarget.dataset.longPressed === "1") {
          delete e.currentTarget.dataset.longPressed;
          return;
        }
        if (anySelected) {
          // Once the user has any cards checked, the whole card surface
          // becomes a select-toggle (Gmail-style sweep). Otherwise it
          // navigates to detail as normal.
          onToggleSelect(event.id, !selected);
          return;
        }
        onOpenDetail(event.id);
      }}
    >
      {/* ⋯ button — always shown (hover-only hid it from touch users).
        * The selection checkbox lives inline in .card-meta (top-left),
        * so the two no longer compete for the top-right slot. */}
      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="card-action-btn overflow"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onOpenMenu(event, { left: r.right - 200, top: r.bottom + 4 });
          }}
          title="Actions"
          aria-label="Actions"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="5"  r="1.8" fill="currentColor"/>
            <circle cx="12" cy="12" r="1.8" fill="currentColor"/>
            <circle cx="12" cy="19" r="1.8" fill="currentColor"/>
          </svg>
        </button>
      </div>

      <div className="card-body">
        <div className="card-meta">
          {/* Always-visible selection checkbox — leftmost slot. Replaces
            * the old hover/selection-mode chrome. Stays subtle until
            * hovered or checked. */}
          <button
            type="button"
            className="card-select"
            data-checked={selected ? "1" : "0"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(event.id, !selected);
            }}
            aria-label={selected ? "Deselect event" : "Select event"}
            aria-pressed={!!selected}
          >
            {selected ? I.check : null}
          </button>

          {/* Author avatar — sits FIRST so the kind→source pair stays
            * visually intact and reads as one unit. For now there are
            * only two states: mine (accent with initial) or unknown
            * (neutral empty circle). Real multi-author support comes
            * later. */}
          <span
            className="author-avatar"
            data-mine={event.mine ? "1" : "0"}
            title={event.mine ? `${CURRENT_USER.name} (you)` : "Unknown author"}
            aria-label={event.mine ? `Author: ${CURRENT_USER.name}` : "Author: unknown"}
          >
            {event.mine ? CURRENT_USER.initial : "?"}
          </span>
          <span className="kind-icon" aria-label={info.label} title={info.label}>
            <KindIcon kind={event.kind} size={18}/>
          </span>
          <span className="src" title={event.src}>{event.src}</span>
          <span className="date">{event.date}</span>
        </div>

        {/* Per-source byline (today: only reddit posts carry a separate
          * author handle below the subreddit). Generic `byline` field so
          * other source kinds can opt in later (press article author,
          * podcast speaker, discord poster, etc). */}
        {event.byline ? (
          <div className="card-byline" title={event.byline}>{event.byline}</div>
        ) : null}

        <h3 className="card-title">{event.title}</h3>

        {showThumb ? (
          <div className={"card-thumb" + (event.thumb ? "" : " empty")}>
            {event.thumb ? (
              <img src={event.thumb} alt="" referrerPolicy="no-referrer" loading="lazy"/>
            ) : (
              <KindIcon kind={event.kind} size={36}/>
            )}
            {event.duration ? <span className="play">▶ {event.duration}</span> : null}
          </div>
        ) : null}

        {event.notes ? <p className="card-notes">{event.notes}</p> : null}

        {event.stats ? (
          <div className="card-stats">
            {event.stats.views != null ? (
              <span className="stat">{I.view} {fmt(event.stats.views)}</span>
            ) : null}
            {event.stats.likes != null ? (
              <span className="stat">{I.heart} {fmt(event.stats.likes)}</span>
            ) : null}
            {event.stats.comments != null ? (
              <span className="stat">{I.chat} {fmt(event.stats.comments)}</span>
            ) : null}
            {event.stats.reads ? (
              <span className="stat" style={{ fontVariant: "tabular-nums" }}>{event.stats.reads}</span>
            ) : null}
          </div>
        ) : null}

        <div className="card-footer">
          <div className="card-footer-chips">
            {games.length === 0 && !event.offTopic ? (
              <span className="inbox-chip">inbox</span>
            ) : null}
            {games.map((g) => (
              <span key={g.id} className="game-chip" style={{ "--game-color": g.color }}>
                {g.icon ? <img className="game-ico" src={g.icon} alt=""/> : null}
                {g.title}
              </span>
            ))}
            {event.offTopic ? (
              <span className="off-topic-chip">Off topic</span>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

function Feed({ events, kindColored, view = "feed", selectedIds, anySelected, onToggleSelect, onOpenPicker, onOpenMenu, onOpenDetail, onDelete }) {
  const groups = groupedEvents(events);
  return (
    <>
      {groups.map(([dateGroup, rows]) => (
        <React.Fragment key={dateGroup}>
          <DateGroupHeader label={dateGroup} count={rows.length}/>
          <div className="feed-grid">
            {rows.map((ev) => (
              <FeedCard
                key={ev.id}
                event={ev}
                kindColored={kindColored}
                view={view}
                selected={selectedIds.has(ev.id)}
                anySelected={anySelected}
                onToggleSelect={onToggleSelect}
                onOpenPicker={onOpenPicker}
                onOpenMenu={onOpenMenu}
                onOpenDetail={onOpenDetail}
                onDelete={onDelete}
              />
            ))}
          </div>
        </React.Fragment>
      ))}
      <div className="feed-grid">
        <div className="feed-footer">No more events.</div>
      </div>
    </>
  );
}

// Empty state for the feed grid — shown when filters narrow to zero,
// or the feed itself is truly empty. Adapts to view (feed vs trash).
function FeedEmpty({ view = "feed", hasFilters, onClearAll, onAdd, onBackToFeed }) {
  if (hasFilters) {
    return (
      <div className="feed-empty">
        <div className="feed-empty-heading">
          {view === "trash" ? "No deleted items match these filters." : "No events match these filters."}
        </div>
        <p className="feed-empty-body">
          Try clearing one of the filters or expanding the date range.
        </p>
        <button className="btn primary" onClick={onClearAll}>Clear all filters</button>
      </div>
    );
  }
  if (view === "trash") {
    return (
      <div className="feed-empty">
        <div className="feed-empty-heading">Trash is empty.</div>
        <p className="feed-empty-body">
          Items you delete will land here. They stay for 30 days before being permanently removed.
        </p>
        <button className="btn primary" onClick={onBackToFeed}>
          ← Back to Feed
        </button>
      </div>
    );
  }
  return (
    <div className="feed-empty">
      <div className="feed-empty-heading">Your feed is empty.</div>
      <p className="feed-empty-body">
        Add a data source on the Sources page to start auto-importing content,
        or paste a one-off URL.
      </p>
      <button className="btn primary" onClick={onAdd}>
        {I.plus}<span>Add event</span>
      </button>
    </div>
  );
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [tab, setTab] = useState("feed");           // "feed" | "sources" (future: games / settings / about)
  const [view, setView] = useState("feed"); // "feed" | "trash"
  const [events, setEvents] = React.useState(EVENTS);
  const [sources, setSources] = React.useState(SOURCES);
  const [deletedEvents, setDeletedEvents] = React.useState([]);
  const [selectedIds, setSelectedIds] = React.useState(() => new Set());
  // Selection is purely derived from selectedIds — no separate "mode" state.
  // Checkbox is always visible on each card; the bulk-bar appears as soon
  // as anything is checked.
  const anySelected = selectedIds.size > 0;
  const [pickerState, setPickerState] = React.useState(null);
  const [menuState, setMenuState]     = React.useState(null);
  const [addModalOpen, setAddModalOpen] = React.useState(false);
  const [openEventId, setOpenEventId] = React.useState(null);
  const [activeKinds, setActiveKinds] = useState([]);
  const [dateRange, setDateRange] = useState("month");
  const [show, setShow] = useState("all");          // all | inbox
  const [game, setGame] = useState([]);             // [] = all | ["gameId", "not_a_game", ...]
  const [author, setAuthor] = useState("anyone");   // anyone | mine | others
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(() => {
    try { return localStorage.getItem("v2-filters-open") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("v2-filters-open", filtersOpen ? "1" : "0"); } catch {}
  }, [filtersOpen]);
  const [sortDir, setSortDir] = useState(() => {
    try { return localStorage.getItem("v2-sort-dir") || "desc"; } catch { return "desc"; }
  });
  useEffect(() => {
    try { localStorage.setItem("v2-sort-dir", sortDir); } catch {}
  }, [sortDir]);

  // Apply theme + vibe + density to <html> for CSS to react to.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", t.theme);
    root.setAttribute("data-vibe", t.vibe);
    root.setAttribute("data-density", t.density);

    // Inject chosen accent (override the token-level default).
    const a = ACCENT_PALETTES[t.accent];
    if (a) {
      root.style.setProperty("--accent", a.val);
      root.style.setProperty("--accent-strong", a.strong);
      root.style.setProperty("--accent-soft", a.soft);
      root.style.setProperty("--accent-text", a.ink);
    }
  }, [t.theme, t.vibe, t.density, t.accent]);

  // Reflect global selection mode on <body> so card-meta can reserve
  // right-padding for the checkbox even on cards that aren't hovered.
  useEffect(() => {
    document.body.setAttribute("data-selection", anySelected ? "1" : "0");
  }, [anySelected]);
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", t.theme);
    root.setAttribute("data-vibe", t.vibe);
    root.setAttribute("data-density", t.density);

    // Inject chosen accent (override the token-level default).
    const a = ACCENT_PALETTES[t.accent];
    if (a) {
      root.style.setProperty("--accent", a.val);
      root.style.setProperty("--accent-strong", a.strong);
      root.style.setProperty("--accent-soft", a.soft);
      root.style.setProperty("--accent-text", a.ink);
    }
  }, [t.theme, t.vibe, t.density, t.accent]);

  // Apply all filter axes for a given hypothetical state. Used both for
  // the current filtered events AND for predicted counts per chip
  // ("if I click this chip, how many will I see").
  const inboxOf = (e) => (e.gameIds?.length ?? 0) === 0 && !e.offTopic;
  function passes(e, s) {
    if (s.show === "inbox" && !inboxOf(e)) return false;
    // Game axis is multi. Empty array = no filter.
    // "off_topic" matches events with the off-topic flag (regardless of
    // game attachment, since the flag is now orthogonal). gameIds[] match
    // any event attached to one of those games. Multiple selections = union.
    if (Array.isArray(s.game) && s.game.length > 0) {
      const inGame = s.game.some((v) =>
        v === "off_topic" ? !!e.offTopic : (e.gameIds ?? []).includes(v)
      );
      if (!inGame) return false;
    }
    if (s.author === "mine"   && !e.mine) return false;
    if (s.author === "others" &&  e.mine) return false;
    if (s.kinds.length > 0 && !s.kinds.includes(e.kind)) return false;
    if (s.dateRange && !dateInRange(e.date, s.dateRange)) return false;
    return true;
  }
  // Source array depends on scope: live feed vs trash.
  const sourceEvents = view === "trash" ? deletedEvents : events;

  const currentState = { show, game, author, kinds: activeKinds, dateRange };
  const visibleEvents = sourceEvents.filter((e) => passes(e, currentState));
  const filteredEvents = (() => {
    if (!query.trim()) return visibleEvents;
    const q = query.trim().toLowerCase();
    return visibleEvents.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        (e.notes ?? "").toLowerCase().includes(q) ||
        (e.src ?? "").toLowerCase().includes(q),
    );
  })();

  // Predicted-count helpers — "what would I see if I clicked this chip".
  const activeFilterCount =
    (show !== "all" ? 1 : 0) +
    game.length +
    (author !== "anyone" ? 1 : 0) +
    activeKinds.length;

  function countWithShow(v)   { return sourceEvents.filter((e) => passes(e, { ...currentState, show:   v })).length; }
  // For multi Game axis: chip count = "events matching THIS game-value
  // (alongside any other Game selections is wrong — we want the standard
  // facet interpretation: if I added this value, narrow). So count =
  // events that match (current other axes) AND this single game value.
  function countWithGame(v) {
    if (v == null || (Array.isArray(v) && v.length === 0)) {
      return sourceEvents.filter((e) => passes(e, { ...currentState, game: [] })).length;
    }
    return sourceEvents.filter((e) => passes(e, { ...currentState, game: [v] })).length;
  }
  function countWithAuthor(v) { return sourceEvents.filter((e) => passes(e, { ...currentState, author: v })).length; }
  function countWithKind(v) {
    if (v == null) return sourceEvents.filter((e) => passes(e, { ...currentState, kinds: [] })).length;
    return sourceEvents.filter((e) => passes(e, { ...currentState, kinds: [v] })).length;
  }

  // Mass-select helpers.
  function toggleSelect(id, on) {
    const next = new Set(selectedIds);
    if (on) next.add(id); else next.delete(id);
    setSelectedIds(next);
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  function openPickerForEvent(event) {
    // Single-card mode: every game is "on" if attached, else "off".
    const gameStates = {};
    for (const g of GAMES) gameStates[g.id] = (event.gameIds ?? []).includes(g.id) ? "on" : "off";
    setPickerState({
      anchorRect: null,
      ids: [event.id],
      initialGameStates: gameStates,
      initialOffTopicState: event.offTopic ? "on" : "off",
    });
  }
  function openPickerForBulk() {
    // Bulk mode: tri-state per game across the selection.
    const targetEvents = events.filter((e) => selectedIds.has(e.id));
    const gameStates = {};
    for (const g of GAMES) {
      const c = targetEvents.reduce((n, e) => n + ((e.gameIds ?? []).includes(g.id) ? 1 : 0), 0);
      gameStates[g.id] = c === 0 ? "off" : c === targetEvents.length ? "on" : "mixed";
    }
    const oc = targetEvents.reduce((n, e) => n + (e.offTopic ? 1 : 0), 0);
    const off = oc === 0 ? "off" : oc === targetEvents.length ? "on" : "mixed";
    setPickerState({
      anchorRect: null,
      ids: [...selectedIds],
      initialGameStates: gameStates,
      initialOffTopicState: off,
    });
  }

  function applyPicker({ gameStates, offTopicState }) {
    const targetIds = new Set(pickerState.ids);
    setEvents(events.map((e) => {
      if (!targetIds.has(e.id)) return e;
      const games = new Set(e.gameIds ?? []);
      for (const [gId, s] of Object.entries(gameStates)) {
        if (s === "on")  games.add(gId);
        if (s === "off") games.delete(gId);
      }
      const off =
        offTopicState === "on"  ? true  :
        offTopicState === "off" ? false :
        !!e.offTopic;
      return { ...e, gameIds: [...games], offTopic: off };
    }));
    const wasBulk = pickerState.ids.length > 1;
    setPickerState(null);
    if (wasBulk) clearSelection();
  }

  function openMenuForEvent(event, pos) {
    setMenuState({ event, pos });
  }

  // Soft delete — move to trash with a deletedAt timestamp.
  function deleteOne(id) {
    const ev = events.find((e) => e.id === id);
    if (!ev) return;
    setEvents(events.filter((e) => e.id !== id));
    setDeletedEvents([{ ...ev, deletedAt: Date.now() }, ...deletedEvents]);
  }
  function deleteSelected() {
    const now = Date.now();
    const ids = selectedIds;
    const moving = events.filter((e) => ids.has(e.id)).map((e) => ({ ...e, deletedAt: now }));
    setEvents(events.filter((e) => !ids.has(e.id)));
    setDeletedEvents([...moving, ...deletedEvents]);
    clearSelection();
  }

  // Restore from trash — pop back into the live feed.
  function restoreOne(id) {
    const ev = deletedEvents.find((e) => e.id === id);
    if (!ev) return;
    const { deletedAt, ...clean } = ev;
    setDeletedEvents(deletedEvents.filter((e) => e.id !== id));
    setEvents([clean, ...events]);
  }
  function restoreSelected() {
    const ids = selectedIds;
    const restoring = deletedEvents.filter((e) => ids.has(e.id))
      .map(({ deletedAt, ...e }) => e);
    setDeletedEvents(deletedEvents.filter((e) => !ids.has(e.id)));
    setEvents([...restoring, ...events]);
    clearSelection();
  }
  function restoreAll() {
    if (deletedEvents.length === 0) return;
    const restoring = deletedEvents.map(({ deletedAt, ...e }) => e);
    setEvents([...restoring, ...events]);
    setDeletedEvents([]);
    clearSelection();
  }

  // Permanently delete — only available in trash view.
  function permanentlyDeleteOne(id) {
    setDeletedEvents(deletedEvents.filter((e) => e.id !== id));
  }
  function permanentlyDeleteSelected() {
    setDeletedEvents(deletedEvents.filter((e) => !selectedIds.has(e.id)));
    clearSelection();
  }
  function emptyTrash() {
    setDeletedEvents([]);
    clearSelection();
  }

  // Switch scope — also drops selection so checks don't leak across.
  function switchView(next) {
    if (next === view) return;
    clearSelection();
    setView(next);
  }

  return (
    <div className="layout">
      <Chrome vibe={t.vibe} currentTab={tab} onSwitchTab={setTab}/>

      <div className="layout-inner">
        {tab === "sources" ? (
          <SourcesPage
            sources={sources}
            onSetSources={setSources}
            onBack={() => setTab("feed")}
          />
        ) : (
        <>
        <PageHead
          view={view}
          onSwitchView={switchView}
          onAdd={() => setAddModalOpen(true)}
          onRestoreAll={restoreAll}
          onEmptyTrash={() => {
            if (deletedEvents.length === 0) return;
            if (window.confirm(`Permanently delete all ${deletedEvents.length} items? This cannot be undone.`)) {
              emptyTrash();
            }
          }}
          deletedCount={deletedEvents.length}
          totalCount={sourceEvents.length}
          filteredCount={filteredEvents.length}
          query={query}
          onQuery={setQuery}
          filtersOpen={filtersOpen}
          onToggleFilters={() => setFiltersOpen((x) => !x)}
          activeFilterCount={activeFilterCount}
          dateRange={dateRange}
          onChangeDateRange={setDateRange}
          sortDir={sortDir}
          onToggleSort={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
        />

        {/* Trash banner — persistent reminder that this is the deleted
          * scope. Lives between page-head and the filter rows so the
          * user can't miss it even when scrolling the chip rows. */}
        {view === "trash" ? (
          <div className="trash-banner" role="status">
            <span className="trash-banner-ico">{I.warn}</span>
            <span>
              You're viewing the trash. Items here are automatically
              removed after 30 days.
            </span>
          </div>
        ) : null}

        {/* Date scope now lives inside PageHead — render after page-head
         * we only mount the dependent feed/filters/results below. */}

        {!filtersOpen ? (
          <ActiveFiltersStrip
            show={show} game={game} author={author} activeKinds={activeKinds}
            onClearShow={() => setShow("all")}
            onClearGame={(v) => setGame(game.filter((x) => x !== v))}
            onClearAuthor={() => setAuthor("anyone")}
            onClearKind={(k) => setActiveKinds(activeKinds.filter((x) => x !== k))}
            onClearAll={() => {
              setShow("all"); setGame([]); setAuthor("anyone"); setActiveKinds([]);
            }}
          />
        ) : null}

        {filtersOpen ? (
          <>
            <AxisRow
              label="Show"
              value={show}
              onChange={setShow}
              options={[
                { key: "all",   value: "all",   label: "All",   count: countWithShow("all") },
                { key: "inbox", value: "inbox", label: "Inbox", count: countWithShow("inbox") },
              ]}
            />

            <AxisRow
              label="Game"
              value={game}
              onChange={setGame}
              multi
              options={[
                { key: "all", value: null, label: "All games", count: countWithGame(null) },
                { key: "off_topic", value: "off_topic", label: "Off topic", count: countWithGame("off_topic") },
                ...GAMES.map((g) => ({
                  key: g.id, value: g.id, label: g.title,
                  gameId: g.id,
                  count: countWithGame(g.id),
                })),
              ]}
            />

            <AxisRow
              label="Author"
              value={author}
              onChange={setAuthor}
              options={[
                { key: "anyone", value: "anyone", label: "Anyone", count: countWithAuthor("anyone") },
                { key: "mine",   value: "mine",   label: "Mine",   count: countWithAuthor("mine") },
                { key: "others", value: "others", label: "Others", count: countWithAuthor("others") },
              ]}
            />

            <AxisRow
              label="Kind"
              value={activeKinds}
              onChange={setActiveKinds}
              multi
              options={[
                { key: "all",            value: null,             label: "All",       count: countWithKind(null) },
                { key: "youtube_video",  value: "youtube_video",  label: "YouTube",   kind: "youtube_video", count: countWithKind("youtube_video") },
                { key: "press",          value: "press",          label: "Press",     kind: "press",         count: countWithKind("press") },
                { key: "reddit_post",    value: "reddit_post",    label: "Reddit",    kind: "reddit_post",   count: countWithKind("reddit_post") },
                { key: "twitter_post",   value: "twitter_post",   label: "Twitter",   kind: "twitter_post",  count: countWithKind("twitter_post") },
                { key: "telegram_post",  value: "telegram_post",  label: "Telegram",  kind: "telegram_post", count: countWithKind("telegram_post") },
                { key: "discord_drop",   value: "discord_drop",   label: "Discord",   kind: "discord_drop",  count: countWithKind("discord_drop") },
                { key: "post",           value: "post",           label: "Post",      kind: "post",          count: countWithKind("post") },
                { key: "conference",     value: "conference",     label: "Conference",kind: "conference",    count: countWithKind("conference") },
                { key: "talk",           value: "talk",           label: "Talk",      kind: "talk",          count: countWithKind("talk") },
                { key: "other",          value: "other",          label: "Other",     kind: "other",         count: countWithKind("other") },
              ]}
            />
          </>
        ) : null}

        {filteredEvents.length === 0 ? (
          <FeedEmpty
            view={view}
            hasFilters={
              show !== "all" || game.length > 0 || author !== "anyone" ||
              activeKinds.length > 0 || query.trim().length > 0
            }
            onClearAll={() => {
              setShow("all"); setGame([]); setAuthor("anyone");
              setActiveKinds([]); setQuery("");
            }}
            onAdd={() => setAddModalOpen(true)}
            onBackToFeed={() => switchView("feed")}
          />
        ) : (
          <Feed
            events={sortDir === "asc" ? [...filteredEvents].reverse() : filteredEvents}
            kindColored={t.kindColor}
            view={view}
            selectedIds={selectedIds}
            anySelected={anySelected}
            onToggleSelect={toggleSelect}
            onOpenPicker={openPickerForEvent}
            onOpenMenu={openMenuForEvent}
            onOpenDetail={setOpenEventId}
            onDelete={view === "trash" ? permanentlyDeleteOne : deleteOne}
          />
        )}
        </>
        )}
      </div>

      <BulkActionBar
        count={selectedIds.size}
        mode={view}
        onOpenPicker={openPickerForBulk}
        onRestore={restoreSelected}
        onDelete={view === "trash" ? permanentlyDeleteSelected : deleteSelected}
        onClear={clearSelection}
      />

      <GamesPicker
        open={!!pickerState}
        anchorRect={pickerState?.anchorRect}
        count={pickerState?.ids.length}
        initialGameStates={pickerState?.initialGameStates}
        initialOffTopicState={pickerState?.initialOffTopicState}
        onApply={applyPicker}
        onClose={() => setPickerState(null)}
      />

      {menuState ? (
        <>
          <div className="picker-scrim" onClick={() => setMenuState(null)}/>
          <div
            className="card-menu"
            style={{ top: menuState.pos.top, left: menuState.pos.left }}
            role="menu"
          >
            {view === "trash" ? (
              <>
                <button
                  className="card-menu-item"
                  onClick={() => {
                    restoreOne(menuState.event.id);
                    setMenuState(null);
                  }}
                >
                  {I.restore}<span>Restore</span>
                </button>
                <button
                  className="card-menu-item"
                  onClick={() => {
                    toggleSelect(menuState.event.id, true);
                    setMenuState(null);
                  }}
                >
                  {I.check}<span>Select</span>
                </button>
                <div className="card-menu-sep"/>
                <button
                  className="card-menu-item danger"
                  onClick={() => {
                    permanentlyDeleteOne(menuState.event.id);
                    setMenuState(null);
                  }}
                >
                  {I.trash}<span>Delete forever</span>
                </button>
              </>
            ) : (
              <>
                <button
                  className="card-menu-item"
                  onClick={() => {
                    openPickerForEvent(menuState.event);
                    setMenuState(null);
                  }}
                >
                  {I.games}<span>Edit games / Off topic</span>
                </button>
                <button
                  className="card-menu-item"
                  onClick={() => {
                    toggleSelect(menuState.event.id, true);
                    setMenuState(null);
                  }}
                >
                  {I.check}<span>Select</span>
                </button>
                <div className="card-menu-sep"/>
                <button
                  className="card-menu-item danger"
                  onClick={() => {
                    deleteOne(menuState.event.id);
                    setMenuState(null);
                  }}
                >
                  {I.trash}<span>Delete</span>
                </button>
              </>
            )}
          </div>
        </>
      ) : null}

      <AddEventModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onCreate={(ev) => setEvents([ev, ...events])}
      />

      {/* Event detail — panel or modal depending on tweak. Navigation
        * is scoped to the currently visible (filtered + sorted) list so
        * the arrows match what the user is browsing. */}
      {(() => {
        if (!openEventId) return null;
        const list = sortDir === "asc" ? [...filteredEvents].reverse() : filteredEvents;
        const idx = list.findIndex((e) => e.id === openEventId);
        const ev = idx >= 0 ? list[idx] : sourceEvents.find((e) => e.id === openEventId);
        if (!ev) return null;
        return (
          <EventDetail
            event={ev}
            view={view}
            mode={t.detailStyle}
            hasPrev={idx > 0}
            hasNext={idx >= 0 && idx < list.length - 1}
            onPrev={() => idx > 0 && setOpenEventId(list[idx - 1].id)}
            onNext={() => idx >= 0 && idx < list.length - 1 && setOpenEventId(list[idx + 1].id)}
            onClose={() => setOpenEventId(null)}
            onDelete={() => {
              if (view === "trash") permanentlyDeleteOne(ev.id);
              else deleteOne(ev.id);
              setOpenEventId(null);
            }}
            onRestore={() => {
              restoreOne(ev.id);
              setOpenEventId(null);
            }}
            onUpdate={(id, patch) => {
              setEvents(events.map((e) => e.id === id ? { ...e, ...patch } : e));
            }}
          />
        );
      })()}

      <TweaksPanel title="Tweaks">
        <TweakSection label="Vibe"/>
        <TweakRadio
          label="Visual"
          value={t.vibe}
          options={["warm", "linear", "stripe"]}
          onChange={(v) => setTweak("vibe", v)}
        />
        <TweakColor
          label="Accent"
          value={ACCENT_PALETTES[t.accent].val}
          options={["#E89B5E", "#E07377", "#7FB46A", "#B488D4"]}
          onChange={(v) => {
            const key = Object.entries(ACCENT_PALETTES).find(([, p]) => p.val === v)?.[0] ?? "amber";
            setTweak("accent", key);
          }}
        />

        <TweakSection label="Layout"/>
        <TweakRadio
          label="Detail style"
          value={t.detailStyle}
          options={["panel", "modal"]}
          onChange={(v) => setTweak("detailStyle", v)}
        />
        <TweakRadio
          label="Density"
          value={t.density}
          options={["compact", "regular"]}
          onChange={(v) => setTweak("density", v)}
        />
        <TweakToggle
          label="Color-code by kind"
          value={t.kindColor}
          onChange={(v) => setTweak("kindColor", v)}
        />

        <TweakSection label="Theme"/>
        <TweakRadio
          label="Mode"
          value={t.theme}
          options={["dark", "light"]}
          onChange={(v) => setTweak("theme", v)}
        />
      </TweaksPanel>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App/>);
