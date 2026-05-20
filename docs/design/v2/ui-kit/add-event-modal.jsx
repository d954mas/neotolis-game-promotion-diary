// Add event modal — single unified form, no tabs.
//
// Decisions baked in (see chat history for rationale):
//   – Title is the ONLY required field.
//   – Default kind = "note" (the manual-log kind).
//   – URL is optional + has a "Fetch" button that mock-parses Open Graph
//     and pre-fills kind/title/thumb. After parse, everything is editable.
//   – If kind is a platform-specific one (youtube/reddit/twitter/etc.) AND
//     a URL is filled, the URL must match the platform's domain.
//   – Games binding uses the same chip vocabulary as the filter rows
//     (color stripe, kind icons), single-select-on-toggle behaviour.
//
// Reuses tokens from tokens.css — no new colors. The dialog chrome reuses
// .picker-scrim from the existing popover styles.

// Reuse useState/useEffect declared in app-data.jsx (top-level const is
// visible across babel scripts). We only need to pull useRef ourselves.
const { useRef: _useRef } = React;

// ─── URL parsing — mock Open Graph fetch ─────────────────────────────────────
// The real backend would hit the URL and read <meta og:*> tags. For the
// prototype we recognise a handful of platforms by hostname and stub
// kind / src / title / thumb. The button shows a brief loading state so
// the UX matches a real network call.
const URL_RULES = [
  { match: /(?:^|\.)(youtube\.com|youtu\.be)$/, kind: "youtube_video", src: "YouTube",
    title: "YouTube video — preview unavailable",
    thumb: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=640&q=70" },
  { match: /(?:^|\.)reddit\.com$/,              kind: "reddit_post",   src: (u) => {
      const m = u.pathname.match(/^\/r\/([^/]+)/); return m ? `r/${m[1]}` : "Reddit";
    }, title: (u) => {
      const m = u.pathname.match(/\/comments\/[^/]+\/([^/]+)/);
      return m ? m[1].replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Reddit post";
    } },
  { match: /(?:^|\.)(twitter\.com|x\.com)$/,    kind: "twitter_post",  src: (u) => {
      const m = u.pathname.match(/^\/([^/]+)/); return m ? `@${m[1]}` : "Twitter";
    }, title: "Twitter post" },
  { match: /(?:^|\.)t\.me$/,                    kind: "telegram_post", src: "Telegram",
    title: "Telegram post" },
  { match: /(?:^|\.)(discord\.com|discord\.gg)$/, kind: "discord_drop", src: "Discord",
    title: "Discord drop" },
];

function parseURL(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl.trim().match(/^https?:\/\//) ? rawUrl.trim() : "https://" + rawUrl.trim());
  } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const rule of URL_RULES) {
    if (rule.match.test(host)) {
      return {
        kind:  rule.kind,
        src:   typeof rule.src === "function"   ? rule.src(u)   : rule.src,
        title: typeof rule.title === "function" ? rule.title(u) : rule.title,
        thumb: rule.thumb ?? null,
      };
    }
  }
  // Generic fallback — treat as "press" mention. Source is the bare host.
  return {
    kind:  "press",
    src:   host,
    title: `Mention on ${host}`,
    thumb: null,
  };
}

// Cheap validator — does this URL's host match the given kind?
// Returns null if the kind doesn't require a specific platform OR the
// URL is empty; otherwise returns an error string or null on match.
const PLATFORM_KINDS = {
  youtube_video: { rx: /(?:^|\.)(youtube\.com|youtu\.be)$/, label: "YouTube" },
  reddit_post:   { rx: /(?:^|\.)reddit\.com$/,              label: "Reddit" },
  twitter_post:  { rx: /(?:^|\.)(twitter\.com|x\.com)$/,    label: "Twitter / X" },
  telegram_post: { rx: /(?:^|\.)t\.me$/,                    label: "Telegram" },
  discord_drop:  { rx: /(?:^|\.)(discord\.com|discord\.gg)$/, label: "Discord" },
};
function validateURLForKind(rawUrl, kind) {
  if (!rawUrl.trim()) return null;
  const rule = PLATFORM_KINDS[kind];
  if (!rule) return null;
  let u;
  try {
    u = new URL(rawUrl.trim().match(/^https?:\/\//) ? rawUrl.trim() : "https://" + rawUrl.trim());
  } catch {
    return "Not a valid URL.";
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!rule.rx.test(host)) return `Doesn't look like a ${rule.label} URL.`;
  return null;
}

// ─── Modal ──────────────────────────────────────────────────────────────────
// The kind chips show the same 11 kinds visible in the filter row (Note
// is added at the top because it's the natural manual-log starting point).
const KIND_ORDER = [
  "note", "youtube_video", "reddit_post", "twitter_post", "telegram_post",
  "discord_drop", "press", "talk", "conference", "post", "other",
];
// 4 most-likely manual-add kinds — visible by default. Currently we
// show all of them in a single wrap (collapse pattern was scrapped), but
// keep the order canonical so most-likely picks land first.
const KIND_TOP = ["note", "press", "post", "talk"];
const KIND_FLOW = [...KIND_TOP, ...KIND_ORDER.filter((k) => !KIND_TOP.includes(k))];
const KIND_SHORT = {
  note: "Note",
  youtube_video: "YouTube",
  reddit_post: "Reddit",
  twitter_post: "Twitter",
  telegram_post: "Telegram",
  discord_drop: "Discord",
  press: "Press",
  talk: "Talk",
  conference: "Conference",
  post: "Post",
  other: "Other",
};

const TODAY_LABEL = (() => {
  // Mirrors TODAY in app.jsx — May 14, 2026.
  const d = new Date(2026, 4, 14);
  const days  = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mon   = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return { date: `${mon[d.getMonth()]} ${d.getDate()}`, group: `${days[d.getDay()]}, ${mon[d.getMonth()]} ${d.getDate()}` };
})();
const TODAY_DATE = new Date(2026, 4, 14);
const _AEM_MON_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const _AEM_DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function _aemToISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function _aemFromISO(iso) {
  const mm = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!mm) return null;
  const d = new Date(+mm[1], +mm[2] - 1, +mm[3]);
  if (isNaN(d.getTime())) return null;
  return d;
}
function _aemLabels(d) {
  const mon = _AEM_MON_NAMES[d.getMonth()];
  const day = _AEM_DAY_NAMES[d.getDay()];
  return { date: `${mon} ${d.getDate()}`, group: `${day}, ${mon} ${d.getDate()}` };
}

function AddEventModal({ open, onClose, onCreate }) {
  const [title, setTitle]   = useState("");
  const [url, setUrl]       = useState("");
  const [kind, setKind]     = useState("note");
  const [notes, setNotes]   = useState("");
  const [games, setGames]   = useState([]);   // array of game ids
  const [offTopic, setOffTopic] = useState(false);
  const [thumb, setThumb]   = useState(null);
  const [src, setSrc]       = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched]   = useState(false);
  const [mine, setMine]     = useState(true);     // default = mine (user logs their own stuff most often)
  const [authorOpen, setAuthorOpen] = useState(false);
  const [dateISO, setDateISO] = useState(_aemToISO(TODAY_DATE));
  const titleRef = _useRef(null);

  // Reset whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setTitle(""); setUrl(""); setKind("note"); setNotes("");
    setGames([]); setOffTopic(false); setThumb(null); setSrc("");
    setFetching(false); setFetched(false);
    setMine(true); setAuthorOpen(false);
    setDateISO(_aemToISO(TODAY_DATE));
    // Don't autofocus the title input — on mobile that pops the virtual
    // keyboard and covers half the form before the user can see what's
    // there. They tap the field themselves when ready.
  }, [open]);

  // Esc to close. Cmd/Ctrl+Enter to save.
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line
  }, [open, title, url, kind, notes, games, offTopic, thumb, src]);

  if (!open) return null;

  function doFetch() {
    if (!url.trim()) return;
    setFetching(true);
    setFetched(false);
    // Mock latency so it reads as a real network call.
    setTimeout(() => {
      const parsed = parseURL(url);
      if (parsed) {
        setKind(parsed.kind);
        // Only overwrite title if the user hasn't typed one yet — we
        // don't want to clobber their intent.
        if (!title.trim()) setTitle(parsed.title);
        setSrc(parsed.src);
        if (parsed.thumb) setThumb(parsed.thumb);
      }
      setFetching(false);
      setFetched(true);
    }, 600);
  }

  function toggleGame(id) {
    setGames(games.includes(id) ? games.filter((x) => x !== id) : [...games, id]);
  }

  const urlError = validateURLForKind(url, kind);
  const canSubmit = title.trim().length > 0 && !urlError && !fetching;

  function submit() {
    if (!canSubmit) return;
    const id = "e_" + Math.random().toString(36).slice(2, 9);
    const d = _aemFromISO(dateISO) ?? TODAY_DATE;
    const labels = _aemLabels(d);
    const event = {
      id, kind,
      date: labels.date,
      dateGroup: labels.group,
      title: title.trim(),
      notes: notes.trim() || null,
      src: src.trim() || (kind === "note" ? "Note" : ""),
      url: url.trim() || null,
      gameIds: games,
      offTopic,
      mine,
      thumb,
      stats: null,
    };
    onCreate(event);
    onClose();
  }

  return (
    <>
      <div className="picker-scrim modal-scrim" onClick={onClose}/>
      <div className="modal" role="dialog" aria-label="Add event" aria-modal="true">
        <div className="modal-head">
          <h2 className="modal-title">Add event</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          {/* Title — required, autofocus. Author picker sits to the right
            * of the label — a single button that shows current author +
            * caret; popover opens for picking. Today there are only two
            * options (Mine / Someone else), but the chip + popover shape
            * is the canonical place where a real authors list will land. */}
          <div className="field">
            <div className="field-label-row">
              <label className="field-label" htmlFor="addevt-title">Title</label>
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
                      <button
                        type="button"
                        className="author-pick-opt"
                        data-active={mine ? "1" : "0"}
                        onClick={() => { setMine(true); setAuthorOpen(false); }}
                      >
                        <span className="author-avatar" data-mine="1">{CURRENT_USER.initial}</span>
                        <span className="author-pick-opt-name">{CURRENT_USER.name}</span>
                        <span className="author-pick-opt-tag">you</span>
                        {mine ? <span className="author-pick-opt-check">{I.check}</span> : null}
                      </button>
                      <button
                        type="button"
                        className="author-pick-opt"
                        data-active={!mine ? "1" : "0"}
                        onClick={() => { setMine(false); setAuthorOpen(false); }}
                      >
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
              ref={titleRef}
              id="addevt-title"
              className="field-input"
              type="text"
              placeholder="What happened?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
          </div>

          {/* Link + Fetch button. After fetch, a small preview chip shows
            * the parsed metadata so the user can verify before saving. */}
          <div className="field">
            <label className="field-label" htmlFor="addevt-url">
              Link <span className="field-label-opt">(optional)</span>
            </label>
            <div className="field-url">
              <input
                id="addevt-url"
                className="field-input"
                type="url"
                placeholder="https://"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setFetched(false); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); doFetch(); }
                }}
                spellCheck="false"
                autoComplete="off"
              />
              <button
                type="button"
                className="btn ghost field-url-fetch"
                onClick={doFetch}
                disabled={!url.trim() || fetching}
              >
                {fetching ? "Fetching…" : "Fetch"}
              </button>
            </div>
            {urlError ? (
              <div className="field-error">{I.warn}<span>{urlError}</span></div>
            ) : fetched && src ? (
              <div className="field-fetch-result">
                <span className="field-fetch-ico" style={{ color: KIND_INFO[kind].color }}>
                  <KindIcon kind={kind} size={14}/>
                </span>
                <span className="field-fetch-text">
                  Detected <b>{KIND_INFO[kind].label}</b>
                  {src ? <>{" · "}<span style={{ fontFamily: "var(--f-mono)", fontSize: 11.5 }}>{src}</span></> : null}
                </span>
                {thumb ? (
                  <button
                    type="button"
                    className="btn-link field-fetch-clear"
                    onClick={() => setThumb(null)}
                    title="Remove thumbnail"
                  >Drop thumb</button>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Kind picker — single wrap row, all 11 kinds. Active chip
            * gets a strong fill in its kind color; inactive chips dim
            * down so the selection pops out without needing arrows. */}
          <div className="field">
            <span className="field-label">Kind</span>
            <div className="kind-grid">
              {KIND_FLOW.map((k) => {
                const info = KIND_INFO[k];
                return (
                  <button
                    key={k}
                    type="button"
                    className="chip kind-chip add-kind-chip"
                    data-active={kind === k ? "1" : "0"}
                    style={{ "--card-accent": info.color }}
                    onClick={() => setKind(k)}
                  >
                    <span className="kind-icon"><KindIcon kind={k} size={16}/></span>
                    <span>{KIND_SHORT[k]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Notes — optional free-text. */}
          <div className="field">
            <label className="field-label" htmlFor="addevt-notes">
              Notes <span className="field-label-opt">(optional)</span>
            </label>
            <textarea
              id="addevt-notes"
              className="field-input field-textarea"
              placeholder="Anything worth remembering — context, numbers, links…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={2000}
            />
          </div>

          {/* Games — same chip visual as the filter axis. Multi-select. */}
          <div className="field">
            <span className="field-label">Games <span className="field-label-opt">(optional)</span></span>
            <div className="kind-grid">
              {GAMES.map((g) => {
                const active = games.includes(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    className="chip kind-chip game-chip add-game-chip"
                    data-active={active ? "1" : "0"}
                    style={{ "--card-accent": g.color }}
                    onClick={() => toggleGame(g.id)}
                  >
                    <span>{g.title}</span>
                  </button>
                );
              })}
              <button
                type="button"
                className="chip kind-chip add-game-chip off-topic-add"
                data-active={offTopic ? "1" : "0"}
                onClick={() => setOffTopic(!offTopic)}
              >
                <span>Off topic</span>
              </button>
            </div>
          </div>

          {/* Quiet footer note — explains where this lands. Date is
            * editable inline via a native date picker overlaid on the
            * label text (same pattern as the Detail view). */}
          <div className="modal-foot-hint">
            Will be saved as <b>your event</b> ·{" "}
            <span className="modal-date-edit">
              <span style={{ fontVariant: "tabular-nums" }}>{_aemLabels(_aemFromISO(dateISO) ?? TODAY_DATE).group}</span>
              <span className="modal-date-pencil" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>
                  <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </span>
              <input
                type="date"
                className="modal-date-native"
                value={dateISO}
                max={_aemToISO(TODAY_DATE)}
                onChange={(e) => { if (e.target.value) setDateISO(e.target.value); }}
                aria-label="Change date"
              />
            </span>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={!canSubmit}>
            Save event
          </button>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { AddEventModal });
