// Event detail view — two chrome variants over the same content.
//
// Mode = "panel": right-side drawer ~540px, lente stays visible to the
// left, scrim dims it. Good for browse-mode: open, scan, close, open
// next card without losing scroll position.
//
// Mode = "modal": centered dialog ~760px wide. More room for content;
// loses the lente context. Same content layout — only the outer chrome
// differs, so a user toggling between them sees identical info.
//
// Both modes:
//   – Esc / X / scrim click → close
//   – ← / → arrows → previous / next event in the current filtered list
//   – Header has kind+src+date+author, close X, nav arrows
//   – Body has: title, thumb (if any), full notes, stats, game chips,
//     "Add a note" composer (placeholder — appends nothing yet)
//   – Footer: in feed = Edit (calls onEdit which opens AddEventModal
//             with prefilled fields — future hook). In trash = Restore
//             + Delete-forever (symmetric with BulkActionBar).

const _useRefDetail = React.useRef;

// Date helpers — mirror the parseEventDate / toISO logic in app.jsx but
// kept local because that file doesn't expose them via window.
const _DET_TODAY = new Date(2026, 4, 14);
const _DET_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const _DET_MON_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const _DET_DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const TODAY = _DET_TODAY;
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
// "May 12" -> ISO "2026-05-12", picking year that rolls back if month
// is in the future relative to TODAY (mirrors parseEventDate in app.jsx).
function dateGroupToISO(s) {
  if (!s) return null;
  // dateGroup looks like "Mon, May 12"; extract the "May 12" tail.
  const m = s.match(/([A-Z][a-z]{2})\s+(\d{1,2})\s*$/);
  if (!m) return null;
  const month = _DET_MONTHS[m[1]];
  if (month == null) return null;
  let year = TODAY.getFullYear();
  if (month > TODAY.getMonth()) year -= 1;
  return toISO(new Date(year, month, parseInt(m[2], 10)));
}
// ISO "2026-04-22" -> { date: "Apr 22", dateGroup: "Wed, Apr 22" }
function isoToEventDate(iso) {
  const mm = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!mm) return null;
  const d = new Date(+mm[1], +mm[2] - 1, +mm[3]);
  if (isNaN(d.getTime())) return null;
  const mon = _DET_MON_NAMES[d.getMonth()];
  const day = _DET_DAY_NAMES[d.getDay()];
  return { date: `${mon} ${d.getDate()}`, dateGroup: `${day}, ${mon} ${d.getDate()}` };
}

function EventDetail({ event, view, mode, hasPrev, hasNext, onPrev, onNext, onClose, onDelete, onRestore, onUpdate }) {
  // Inline-edit drafts. `null` = not editing; string = current draft value.
  const [titleDraft, setTitleDraft] = useState(null);
  const [notesDraft, setNotesDraft] = useState(null);
  const [urlDraft, setUrlDraft]     = useState(null);
  const [authorOpen, setAuthorOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const isPanel = mode === "panel";
  const inTrash = view === "trash";

  // Esc + arrow navigation. Effect re-binds when event changes so the
  // callbacks see the right "next" id.
  useEffect(() => {
    if (!event) return;
    function onKey(e) {
      if (e.target.matches("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "ArrowLeft"  && hasPrev) { e.preventDefault(); onPrev(); }
      if (e.key === "ArrowRight" && hasNext) { e.preventDefault(); onNext(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [event?.id, hasPrev, hasNext, onPrev, onNext, onClose]);

  // Reset drafts whenever we switch events.
  useEffect(() => {
    setTitleDraft(null);
    setNotesDraft(null);
    setUrlDraft(null);
    setAuthorOpen(false);
    setOverflowOpen(false);
  }, [event?.id]);

  if (!event) return null;

  const info = KIND_INFO[event.kind] ?? KIND_INFO.other;
  const games = (event.gameIds ?? []).map((id) => gameById[id]).filter(Boolean);
  const showThumb = !!event.thumb || event.kind === "youtube_video";

  // Content body — identical for both modes.
  const content = (
    <>
      {/* Meta row — same compact layout as the feed card so the user
        * recognises the structure at a glance: [avatar] [kind icon]
        * source · date. All three of avatar / kind icon / date are
        * affordances: click to open author popover, kind is read-only,
        * date opens a native date picker. */}
      <div className="detail-meta detail-meta-compact">
        {/* Author \u2014 small avatar, click opens popover. Same popover
          * vocabulary as in the Add Event modal. */}
        {!inTrash ? (
          <div className="author-pick" style={{ position: "relative" }}>
            <button
              type="button"
              className="author-avatar detail-author-trigger"
              data-mine={event.mine ? "1" : "0"}
              onClick={() => setAuthorOpen(!authorOpen)}
              aria-haspopup="listbox"
              aria-expanded={authorOpen}
              title={event.mine ? `${CURRENT_USER.name} (you) \u2014 click to change` : "Unknown author \u2014 click to change"}
            >
              {event.mine ? CURRENT_USER.initial : "?"}
            </button>
            {authorOpen ? (
              <>
                <div className="author-pick-scrim" onClick={() => setAuthorOpen(false)}/>
                <div className="author-pick-pop" role="listbox" style={{ left: 0, right: "auto" }}>
                  <button
                    type="button"
                    className="author-pick-opt"
                    data-active={event.mine ? "1" : "0"}
                    onClick={() => { onUpdate?.(event.id, { mine: true }); setAuthorOpen(false); }}
                  >
                    <span className="author-avatar" data-mine="1">{CURRENT_USER.initial}</span>
                    <span className="author-pick-opt-name">{CURRENT_USER.name}</span>
                    <span className="author-pick-opt-tag">you</span>
                    {event.mine ? <span className="author-pick-opt-check">{I.check}</span> : null}
                  </button>
                  <button
                    type="button"
                    className="author-pick-opt"
                    data-active={!event.mine ? "1" : "0"}
                    onClick={() => { onUpdate?.(event.id, { mine: false }); setAuthorOpen(false); }}
                  >
                    <span className="author-avatar" data-mine="0">?</span>
                    <span className="author-pick-opt-name">Someone else</span>
                    {!event.mine ? <span className="author-pick-opt-check">{I.check}</span> : null}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <span
            className="author-avatar"
            data-mine={event.mine ? "1" : "0"}
            title={event.mine ? `${CURRENT_USER.name} (you)` : "Unknown author"}
          >
            {event.mine ? CURRENT_USER.initial : "?"}
          </span>
        )}

        {/* Kind icon \u2014 read-only color-coded glyph, just like the card. */}
        <span className="kind-icon" style={{ color: info.color }} title={info.label}>
          <KindIcon kind={event.kind} size={18}/>
        </span>

        <span className="detail-src" title={event.src}>{event.src}</span>
        <span className="detail-sep">·</span>

        {/* Date — clickable. The native <input type="date"> overlays
          * invisibly on top so the user gets the OS date picker without
          * us building one. Edit disabled in trash. */}
        {!inTrash ? (
          <span className="detail-date-edit">
            <span className="detail-date">{event.dateGroup}</span>
            <span className="detail-date-pencil" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>
                <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </span>
            <input
              type="date"
              className="detail-date-native"
              value={dateGroupToISO(event.dateGroup) || ""}
              max={toISO(TODAY)}
              onChange={(e) => {
                const next = isoToEventDate(e.target.value);
                if (next) onUpdate?.(event.id, next);
              }}
              aria-label="Change date"
              title="Change date"
            />
          </span>
        ) : (
          <span className="detail-date">{event.dateGroup}</span>
        )}

        {/* Per-source byline — second row (flex-basis: 100% in CSS). Only
          * rendered when the source has a sub-identity beyond its name.
          * Today only reddit_post fills it; other kinds may follow. */}
        {event.byline ? (
          <div className="detail-byline" title={event.byline}>{event.byline}</div>
        ) : null}
      </div>

      {/* Title — click to inline-edit (single-line input). Enter or
        * blur saves; Esc reverts. Edit is disabled in trash scope. */}
      {titleDraft != null && !inTrash ? (
        <input
          className="detail-title detail-title-input"
          autoFocus
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => {
            const next = titleDraft.trim();
            if (next && next !== event.title) onUpdate?.(event.id, { title: next });
            setTitleDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
            if (e.key === "Escape") { setTitleDraft(null); }
          }}
          maxLength={300}
        />
      ) : (
        <div className="detail-editable-row">
          <h2
            className={"detail-title" + (!inTrash ? " is-editable" : "")}
            onClick={() => !inTrash && setTitleDraft(event.title)}
          >
            {event.title}
          </h2>
          {!inTrash ? (
            <button
              type="button"
              className="detail-edit-btn"
              onClick={() => setTitleDraft(event.title)}
              title="Edit title"
              aria-label="Edit title"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>
                <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
          ) : null}
        </div>
      )}

      {/* URL row — always visible. For platform-locked kinds (youtube,
        * reddit, twitter, telegram, discord) the URL is read-only since
        * it binds the event to its source. For freeform kinds it's
        * inline-editable like title/notes. The ↗ button opens it. */}
      {(() => {
        const URL_LOCKED_KINDS = new Set([
          "youtube_video", "reddit_post", "twitter_post",
          "telegram_post", "discord_drop",
        ]);
        const isLocked = URL_LOCKED_KINDS.has(event.kind);
        const url = event.url ?? "";
        const editable = !inTrash && !isLocked;

        if (urlDraft != null && editable) {
          return (
            <div className="detail-url">
              <input
                className="field-input detail-url-input"
                autoFocus
                type="url"
                placeholder="https://"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onBlur={() => {
                  const next = urlDraft.trim();
                  if (next !== (event.url ?? "")) {
                    onUpdate?.(event.id, { url: next || null });
                  }
                  setUrlDraft(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
                  if (e.key === "Escape") { setUrlDraft(null); }
                }}
              />
            </div>
          );
        }
        return (
          <div className="detail-url">
            {url ? (
              <>
                <a
                  className="detail-url-text"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={url}
                  onClick={(e) => e.stopPropagation()}
                >
                  {url}
                </a>
                {editable ? (
                  <button
                    type="button"
                    className="detail-edit-btn"
                    onClick={() => setUrlDraft(url)}
                    title="Edit URL"
                    aria-label="Edit URL"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>
                      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                ) : null}
              </>
            ) : editable ? (
              <button
                type="button"
                className="detail-url-text detail-url-empty is-editable"
                onClick={() => setUrlDraft("")}
                title="Click to add URL"
              >
                Click to add URL…
              </button>
            ) : (
              <span className="detail-url-text detail-url-empty">No URL.</span>
            )}
          </div>
        );
      })()}

      {showThumb ? (
        <div className={"detail-thumb" + (event.thumb ? "" : " empty")}>
          {event.thumb ? (
            <img src={event.thumb} alt="" referrerPolicy="no-referrer"/>
          ) : (
            <KindIcon kind={event.kind} size={48}/>
          )}
          {event.duration ? <span className="play">▶ {event.duration}</span> : null}
        </div>
      ) : null}

      {/* Notes — full text, click to edit. Cmd/Ctrl+Enter saves, Esc
        * reverts. Empty-state hint becomes "Click to add notes" when
        * not in trash. */}
      {notesDraft != null && !inTrash ? (
        <textarea
          className="field-input field-textarea detail-notes-input"
          autoFocus
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          onBlur={() => {
            const next = notesDraft.trim();
            if ((next || event.notes) && next !== (event.notes ?? "")) {
              onUpdate?.(event.id, { notes: next || null });
            }
            setNotesDraft(null);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault(); e.target.blur();
            }
            if (e.key === "Escape") { e.stopPropagation(); setNotesDraft(null); }
          }}
          rows={4}
          maxLength={4000}
        />
      ) : event.notes ? (
        <div className="detail-editable-row">
          <p
            className={"detail-notes" + (!inTrash ? " is-editable" : "")}
            onClick={() => !inTrash && setNotesDraft(event.notes ?? "")}
          >
            {event.notes}
          </p>
          {!inTrash ? (
            <button
              type="button"
              className="detail-edit-btn"
              onClick={() => setNotesDraft(event.notes ?? "")}
              title="Edit notes"
              aria-label="Edit notes"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>
                <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
          ) : null}
        </div>
      ) : !inTrash ? (
        <button
          type="button"
          className="detail-notes detail-notes-empty is-editable detail-empty-btn"
          onClick={() => setNotesDraft("")}
        >
          Click to add notes…
        </button>
      ) : (
        <p className="detail-notes detail-notes-empty">No notes.</p>
      )}

      {event.stats ? (
        <div className="detail-stats">
          {event.stats.views != null ? (
            <span className="detail-stat">{I.view}<b>{fmt(event.stats.views)}</b><span>views</span></span>
          ) : null}
          {event.stats.likes != null ? (
            <span className="detail-stat">{I.heart}<b>{fmt(event.stats.likes)}</b><span>likes</span></span>
          ) : null}
          {event.stats.comments != null ? (
            <span className="detail-stat">{I.chat}<b>{fmt(event.stats.comments)}</b><span>comments</span></span>
          ) : null}
          {event.stats.reads ? (
            <span className="detail-stat detail-stat-text">{event.stats.reads}</span>
          ) : null}
        </div>
      ) : null}

      <div className="detail-section">
        <span className="detail-section-label">Games</span>
        {inTrash ? (
          <div className="detail-game-row">
            {games.length === 0 && !event.offTopic ? (
              <span className="inbox-chip">inbox</span>
            ) : null}
            {games.map((g) => (
              <span key={g.id} className="game-chip" style={{ "--game-color": g.color }}>
                <span className="game-ico"/>
                {g.title}
              </span>
            ))}
            {event.offTopic ? <span className="off-topic-chip">Off topic</span> : null}
          </div>
        ) : (
          /* Inline-editable chip row — same visual vocabulary as the
            * Add Event modal. Click a game chip to toggle attachment;
            * click Off topic to flag. No extra popover. */
          <div className="kind-grid">
            {GAMES.map((g) => {
              const active = (event.gameIds ?? []).includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  className="chip kind-chip game-chip add-game-chip"
                  data-active={active ? "1" : "0"}
                  style={{ "--card-accent": g.color }}
                  onClick={() => {
                    const ids = new Set(event.gameIds ?? []);
                    if (active) ids.delete(g.id); else ids.add(g.id);
                    onUpdate?.(event.id, { gameIds: [...ids] });
                  }}
                >
                  <span>{g.title}</span>
                </button>
              );
            })}
            <button
              type="button"
              className="chip kind-chip add-game-chip off-topic-add"
              data-active={event.offTopic ? "1" : "0"}
              onClick={() => onUpdate?.(event.id, { offTopic: !event.offTopic })}
            >
              <span>Off topic</span>
            </button>
          </div>
        )}
      </div>

      {!inTrash ? null : null}
    </>
  );

  // Header — same in both modes (close X + nav arrows on the right).
  // Header — minimal: just the nav arrows for browsing between events.
  // Close + Delete moved to the bottom dock (D pattern) so primary
  // actions are thumb-reachable on mobile and Delete is one tap
  // behind the overflow menu, not a permanently lit destructive button.
  const header = (
    <div className="detail-head">
      <div className="detail-head-nav">
        <button
          type="button"
          className="detail-nav-btn"
          onClick={onPrev}
          disabled={!hasPrev}
          title="Previous event (←)"
          aria-label="Previous event"
        >‹</button>
        <button
          type="button"
          className="detail-nav-btn"
          onClick={onNext}
          disabled={!hasNext}
          title="Next event (→)"
          aria-label="Next event"
        >›</button>
      </div>
      <div className="detail-head-spacer"/>
    </div>
  );

  // Bottom dock — primary close (largest target, on the left), context
  // action (Open source / Restore), and an overflow menu on the right
  // that hides destructive + future actions (Delete, Pin, Duplicate…).
  // In trash scope Delete forever and Restore swap roles.
  const footer = (
    <div className="detail-foot">
      <button
        className="btn ghost detail-foot-close"
        onClick={onClose}
        title="Close (Esc)"
      >
        <span style={{ fontSize: 18, lineHeight: 1, marginRight: 2 }}>×</span>
        <span>Close</span>
      </button>
      {inTrash ? (
        <button className="btn ghost" onClick={onRestore}>
          {I.restore}<span>Restore</span>
        </button>
      ) : null}
      <div style={{ flex: 1 }}/>
      <div className="detail-foot-overflow">
        <button
          type="button"
          className="btn ghost detail-foot-overflow-btn"
          onClick={() => setOverflowOpen(!overflowOpen)}
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          title="More actions"
          aria-label="More actions"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5"  cy="12" r="1.8" fill="currentColor"/>
            <circle cx="12" cy="12" r="1.8" fill="currentColor"/>
            <circle cx="19" cy="12" r="1.8" fill="currentColor"/>
          </svg>
        </button>
        {overflowOpen ? (
          <>
            <div className="author-pick-scrim" onClick={() => setOverflowOpen(false)}/>
            <div className="detail-foot-overflow-pop" role="menu">
              <button
                className="card-menu-item danger"
                onClick={() => { setOverflowOpen(false); onDelete(); }}
              >
                {I.trash}<span>{inTrash ? "Delete forever" : "Delete"}</span>
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );

  if (isPanel) {
    return (
      <>
        <div className="detail-scrim detail-scrim-panel" onClick={onClose}/>
        <aside
          className="detail-panel"
          role="dialog"
          aria-label={`Event: ${event.title}`}
        >
          {header}
          <div className="detail-body">{content}</div>
          {footer}
        </aside>
      </>
    );
  }

  // Modal mode.
  return (
    <>
      <div className="detail-scrim detail-scrim-modal" onClick={onClose}/>
      <div
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Event: ${event.title}`}
      >
        {header}
        <div className="detail-body">{content}</div>
        {footer}
      </div>
    </>
  );
}

Object.assign(window, { EventDetail });
