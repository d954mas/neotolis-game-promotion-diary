// Sources page — list of connected data feeds (YouTube / Reddit MVP).
//
// Visual: rows-as-cards. Each row carries:
//   - kind icon tile with author marker overlay
//   - handle (mono, inline-editable via pencil)
//   - status pill (Live / Paused — clickable, toggles active)
//   - last-synced + big "Sync" button
//   - event count
//   - ⋯ overflow (change author, remove)
//
// Editable: handle (pencil inline), author (in ⋯ menu), active (status pill).
// Kind is fixed at create time.

function deriveSourceName(handle, kind) {
  const t = (handle ?? "").trim();
  if (!t) return "";
  if (kind === "reddit_post") {
    const m = t.match(/r\/([A-Za-z0-9_]+)/);
    return m ? `r/${m[1]}` : t;
  }
  if (kind === "youtube_video") {
    const m = t.match(/@([A-Za-z0-9_.-]+)/);
    return m ? `@${m[1]}` : t;
  }
  return t;
}

function SourceRow({ source, onToggleActive, onSync, onRemove, onUpdate }) {
  const info = KIND_INFO[source.kind] ?? KIND_INFO.other;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const [authorOpen, setAuthorOpen] = useState(false);
  const display = deriveSourceName(source.handle, source.kind);

  return (
    <article
      className="source-row"
      data-active={source.active ? "1" : "0"}
      style={{ "--card-accent": info.color }}
    >
      {/* ⋯ overflow in top-right — same affordance as feed-cards. */}
      <div className="card-actions">
        <button
          type="button"
          className="card-action-btn overflow"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setMenuPos({ left: r.right - 220, top: r.bottom + 4 });
            setMenuOpen(true);
          }}
          title="More actions"
          aria-label="More actions"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="5"  r="1.8" fill="currentColor"/>
            <circle cx="12" cy="12" r="1.8" fill="currentColor"/>
            <circle cx="12" cy="19" r="1.8" fill="currentColor"/>
          </svg>
        </button>
      </div>

      {/* Title row — mini kind icon + author avatar (clickable) + handle.
        * Single line, mirrors the feed-card meta vocabulary
        * ([kind] [author] [src]) so users recognise the pair. The big
        * kind tile and the loud author chip are gone. */}
      <h3 className="source-title">
        <span className="kind-icon" title={info.label} aria-label={info.label}>
          <KindIcon kind={source.kind} size={16}/>
        </span>

        <span className="author-pick" style={{ position: "relative", display: "inline-flex" }}>
          <button
            type="button"
            className="author-avatar source-author-trigger"
            data-mine={source.author === "mine" ? "1" : "0"}
            onClick={(e) => { e.stopPropagation(); setAuthorOpen(!authorOpen); }}
            aria-haspopup="listbox"
            aria-expanded={authorOpen}
            title={source.author === "mine" ? `${CURRENT_USER.name} (you) — click to change` : "Someone else — click to change"}
          >
            {source.author === "mine" ? CURRENT_USER.initial : "?"}
          </button>
          {authorOpen ? (
            <>
              <div className="author-pick-scrim" onClick={() => setAuthorOpen(false)}/>
              <div className="author-pick-pop" role="listbox" style={{ left: 0, right: "auto" }}>
                <button type="button" className="author-pick-opt" data-active={source.author === "mine" ? "1" : "0"} onClick={() => { onUpdate(source.id, { author: "mine" }); setAuthorOpen(false); }}>
                  <span className="author-avatar" data-mine="1">{CURRENT_USER.initial}</span>
                  <span className="author-pick-opt-name">{CURRENT_USER.name}</span>
                  <span className="author-pick-opt-tag">you</span>
                  {source.author === "mine" ? <span className="author-pick-opt-check">{I.check}</span> : null}
                </button>
                <button type="button" className="author-pick-opt" data-active={source.author !== "mine" ? "1" : "0"} onClick={() => { onUpdate(source.id, { author: "others" }); setAuthorOpen(false); }}>
                  <span className="author-avatar" data-mine="0">?</span>
                  <span className="author-pick-opt-name">Someone else</span>
                  {source.author !== "mine" ? <span className="author-pick-opt-check">{I.check}</span> : null}
                </button>
              </div>
            </>
          ) : null}
        </span>

        <span className="source-title-text" title={display}>{display}</span>
      </h3>

      <div className="source-actions">
        <button
          type="button"
          className="btn ghost source-sync-btn"
          onClick={() => onSync(source.id)}
          title="Sync now"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 0 1 15-6.7L21 7"/>
            <path d="M21 3v4h-4"/>
            <path d="M21 12a9 9 0 0 1-15 6.7L3 17"/>
            <path d="M3 21v-4h4"/>
          </svg>
          <span>Sync</span>
        </button>
        <button
          type="button"
          className="source-toggle"
          data-on={source.active ? "1" : "0"}
          onClick={() => onToggleActive(source.id)}
          aria-pressed={source.active}
          aria-label={source.active ? "Pause source" : "Resume source"}
          title={source.active ? "Pause" : "Resume"}
        >
          <span className="source-toggle-thumb"/>
        </button>
      </div>

      {/* ⋯ overflow — absolute top-right corner, mirrors feed-card. */}
      <div className="card-actions">
        <button
          type="button"
          className="card-action-btn overflow"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setMenuPos({ left: r.right - 220, top: r.bottom + 4 });
            setMenuOpen(true);
          }}
          title="More actions"
          aria-label="More actions"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="5"  r="1.8" fill="currentColor"/>
            <circle cx="12" cy="12" r="1.8" fill="currentColor"/>
            <circle cx="12" cy="19" r="1.8" fill="currentColor"/>
          </svg>
        </button>
      </div>

      {/* Full-width footer — N events left, synced right. Spans under
        * the kind tile + main + actions, so the right side doesn't
        * collide with the inner-row stats anymore. */}
      <div className="source-foot">
        <span>{source.eventCount} events</span>
        {source.dateRange ? (
          <>
            <span className="source-foot-sep">·</span>
            <span className="source-foot-range">{source.dateRange}</span>
          </>
        ) : null}
        <span className="source-foot-sep">·</span>
        <span>synced {source.lastSynced}</span>
      </div>

      {menuOpen ? (
        <>
          <div className="picker-scrim" onClick={() => setMenuOpen(false)}/>
          <div className="card-menu" style={{ top: menuPos.top, left: menuPos.left }} role="menu">
            <button
              className="card-menu-item danger"
              onClick={() => { onRemove(source.id); setMenuOpen(false); }}
            >
              {I.trash}<span>Remove source</span>
            </button>
          </div>
        </>
      ) : null}
    </article>
  );
}

// ─── Add Source modal ──────────────────────────────────────────────────────
const SRC_PLATFORMS = [
  { kind: "youtube_video", label: "YouTube", placeholder: "https://youtube.com/@channel or @handle" },
  { kind: "reddit_post",   label: "Reddit",  placeholder: "r/SubredditName or reddit.com/r/..." },
];

function parseSourceURL(rawUrl, kind) {
  const t = rawUrl.trim();
  if (!t) return null;
  if (kind === "youtube_video") {
    const m = t.match(/@([A-Za-z0-9_.-]+)/);
    if (m) return { handle: `@${m[1]}` };
    return { handle: t };
  }
  if (kind === "reddit_post") {
    const m = t.match(/r\/([A-Za-z0-9_]+)/);
    if (m) return { handle: `r/${m[1]}` };
    return { handle: t };
  }
  return null;
}

function AddSourceModal({ open, onClose, onCreate }) {
  const [kind, setKind] = useState("youtube_video");
  const [url, setUrl]   = useState("");
  const [mine, setMine] = useState(false);
  const [authorOpen, setAuthorOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind("youtube_video"); setUrl(""); setMine(false); setAuthorOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const platform = SRC_PLATFORMS.find((p) => p.kind === kind);
  const canSubmit = url.trim().length > 0;

  function submit() {
    if (!canSubmit) return;
    const parsed = parseSourceURL(url, kind) ?? { handle: url };
    const id = "s_" + Math.random().toString(36).slice(2, 9);
    onCreate({
      id, kind,
      handle: parsed.handle,
      author: mine ? "mine" : "others",
      active: true,
      lastSynced: "just now",
      eventCount: 0,
    });
    onClose();
  }

  return (
    <>
      <div className="picker-scrim modal-scrim" onClick={onClose}/>
      <div className="modal" role="dialog" aria-label="Add source" aria-modal="true">
        <div className="modal-head">
          <h2 className="modal-title">Add source</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          <div className="field">
            <span className="field-label">Platform</span>
            <div className="kind-grid">
              {SRC_PLATFORMS.map((p) => {
                const info = KIND_INFO[p.kind];
                return (
                  <button
                    key={p.kind}
                    type="button"
                    className="chip kind-chip add-kind-chip"
                    data-active={kind === p.kind ? "1" : "0"}
                    style={{ "--card-accent": info.color }}
                    onClick={() => setKind(p.kind)}
                  >
                    <span className="kind-icon"><KindIcon kind={p.kind} size={16}/></span>
                    <span>{p.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="field">
            <div className="field-label-row">
              <label className="field-label" htmlFor="addsrc-url">URL or handle</label>
              <div className="author-pick">
                <button
                  type="button"
                  className="author-pick-trigger"
                  onClick={() => setAuthorOpen(!authorOpen)}
                  aria-haspopup="listbox"
                  aria-expanded={authorOpen}
                >
                  <span className="author-avatar" data-mine={mine ? "1" : "0"}>
                    {mine ? CURRENT_USER.initial : "?"}
                  </span>
                  <span className="author-pick-name">
                    {mine ? CURRENT_USER.name : "Someone else"}
                  </span>
                  <span className="author-pick-chev">{I.chev}</span>
                </button>
                {authorOpen ? (
                  <>
                    <div className="author-pick-scrim" onClick={() => setAuthorOpen(false)}/>
                    <div className="author-pick-pop" role="listbox">
                      <button type="button" className="author-pick-opt" data-active={mine ? "1" : "0"} onClick={() => { setMine(true); setAuthorOpen(false); }}>
                        <span className="author-avatar" data-mine="1">{CURRENT_USER.initial}</span>
                        <span className="author-pick-opt-name">{CURRENT_USER.name}</span>
                        <span className="author-pick-opt-tag">you</span>
                        {mine ? <span className="author-pick-opt-check">{I.check}</span> : null}
                      </button>
                      <button type="button" className="author-pick-opt" data-active={!mine ? "1" : "0"} onClick={() => { setMine(false); setAuthorOpen(false); }}>
                        <span className="author-avatar" data-mine="0">?</span>
                        <span className="author-pick-opt-name">Someone else</span>
                        {!mine ? <span className="author-pick-opt-check">{I.check}</span> : null}
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
            <input
              id="addsrc-url"
              className="field-input"
              type="text"
              placeholder={platform.placeholder}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck="false"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={!canSubmit}>
            Add source
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Sources page shell ───────────────────────────────────────────────────
function SourcesPage({ sources, onSetSources }) {
  const [addOpen, setAddOpen] = useState(false);

  function toggleActive(id) {
    onSetSources(sources.map((s) => s.id === id ? { ...s, active: !s.active } : s));
  }
  function syncNow(id) {
    onSetSources(sources.map((s) => s.id === id ? { ...s, lastSynced: "just now" } : s));
  }
  function removeSource(id) {
    onSetSources(sources.filter((s) => s.id !== id));
  }
  function updateSource(id, patch) {
    onSetSources(sources.map((s) => s.id === id ? { ...s, ...patch } : s));
  }
  function createSource(src) {
    onSetSources([src, ...sources]);
  }

  // Group by platform — quick read of "what kinds of sources I have".
  const groups = [];
  for (const p of SRC_PLATFORMS) {
    const items = sources.filter((s) => s.kind === p.kind);
    groups.push({ ...p, items });
  }

  return (
    <>
      <header className="page-head">
        <div className="page-head-row top">
          <div className="page-head-titlegroup">
            <h1 className="page-title">Sources</h1>
            <span className="page-head-summary">
              <b>{sources.length}</b> connected
              <span className="sep">·</span>
              <b>{sources.reduce((n, s) => n + s.eventCount, 0)}</b> events imported
            </span>
          </div>
          <button className="btn add-event" onClick={() => setAddOpen(true)}>
            {I.plus}<span>Add source</span>
          </button>
        </div>
      </header>

      {sources.length === 0 ? (
        <div className="feed-empty">
          <div className="feed-empty-heading">No sources connected.</div>
          <p className="feed-empty-body">
            Connect a YouTube channel or a Reddit sub to start auto-importing
            events into your feed.
          </p>
          <button className="btn primary" onClick={() => setAddOpen(true)}>
            {I.plus}<span>Add source</span>
          </button>
        </div>
      ) : (
        <div className="sources-list">
          {groups.map((g) => g.items.length > 0 ? (
            <section key={g.kind} className="sources-group">
              <header className="sources-group-head">
                <span className="kind-icon" style={{ color: KIND_INFO[g.kind].color }}>
                  <KindIcon kind={g.kind} size={16}/>
                </span>
                <h2 className="sources-group-title">{g.label}</h2>
                <span className="sources-group-count">{g.items.length}</span>
                <div className="sources-group-rule"/>
              </header>
              <div className="sources-rows">
                {g.items.map((s) => (
                  <SourceRow
                    key={s.id}
                    source={s}
                    onToggleActive={toggleActive}
                    onSync={syncNow}
                    onRemove={removeSource}
                    onUpdate={updateSource}
                  />
                ))}
              </div>
            </section>
          ) : null)}
        </div>
      )}

      <AddSourceModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreate={createSource}
      />
    </>
  );
}

Object.assign(window, { SourcesPage });
