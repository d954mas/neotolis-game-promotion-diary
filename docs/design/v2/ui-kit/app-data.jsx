// Neotolis v2 feed prototype.
// Single-file React app. The chrome is sticky; the page is a Feed
// pretending to be the marquee surface of the product.

const { useState, useEffect } = React;

// ─── icon set ────────────────────────────────────────────────────────────────
// Stroked geometric SVGs at 16/20/24 sizes. Stays inside the "no brand mark"
// contract from v1.
const I = {
  feed:   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg>,
  sources:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="2.5"/><path d="M12 4v3"/><path d="M12 17v3"/><path d="M4 12h3"/><path d="M17 12h3"/><path d="M6.34 6.34l2.12 2.12"/><path d="M15.54 15.54l2.12 2.12"/><path d="M6.34 17.66l2.12-2.12"/><path d="M15.54 8.46l2.12-2.12"/></svg>,
  games:  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="18" height="11" rx="3"/><path d="M8 11v3"/><path d="M6.5 12.5h3"/><circle cx="15.5" cy="11.5" r=".7" fill="currentColor"/><circle cx="17.5" cy="13.5" r=".7" fill="currentColor"/></svg>,
  games:  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="18" height="11" rx="3"/><path d="M8 11v3"/><path d="M6.5 12.5h3"/><circle cx="15.5" cy="11.5" r=".7" fill="currentColor"/><circle cx="17.5" cy="13.5" r=".7" fill="currentColor"/></svg>,
  check:  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  trash:  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>,
  settings:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  bell:   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>,
  search: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>,
  plus:   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>,
  filter: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18"/><path d="M6 12h12"/><path d="M10 19h4"/></svg>,
  chev:   <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round"><path d="m6 9 6 6 6-6"/></svg>,
  cal:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>,
  view:   <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>,
  heart:  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>,
  chat:   <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  info:   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".9" fill="currentColor" stroke="none"/></svg>,
  restore:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>,
  warn:   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5"/><circle cx="12" cy="18" r=".9" fill="currentColor" stroke="none"/></svg>,
  arrowLeft: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>,
};

// Kind-specific icons (reuse v1 set but with color-driven currentColor).
function KindIcon({ kind, size = 14 }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  switch (kind) {
    case "youtube_video": return <svg {...p}><rect x="2.5" y="5.5" width="19" height="13" rx="3.5"/><path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none"/></svg>;
    case "reddit_post": {
      // Snoo-style mark: round head with two pointy ears + antenna +
      // small eyes + smile. Reads as Reddit at small sizes.
      const f = { fill: "currentColor", stroke: "none" };
      return (
        <svg {...p}>
          {/* antenna */}
          <circle cx="18.5" cy="5" r="1.4" {...f}/>
          <path d="M14.7 11.2 17.5 6.5"/>
          {/* head */}
          <circle cx="12" cy="13.5" r="6.5" {...f}/>
          {/* ears (sit on top of head silhouette) */}
          <circle cx="7"  cy="9.5"  r="1.6" {...f}/>
          <circle cx="17" cy="9.5"  r="1.6" {...f}/>
          {/* eyes — cut-out by drawing in bg color over the head */}
          <circle cx="9.5"  cy="13" r="1.1" fill="var(--surface)" stroke="none"/>
          <circle cx="14.5" cy="13" r="1.1" fill="var(--surface)" stroke="none"/>
          <circle cx="9.5"  cy="13" r=".45" {...f}/>
          <circle cx="14.5" cy="13" r=".45" {...f}/>
          {/* smile */}
          <path d="M9.5 16c1.5 1.2 3.5 1.2 5 0" stroke="var(--surface)" strokeWidth="1.2" fill="none"/>
        </svg>
      );
    }
    case "twitter_post":  return <svg {...p}><path d="M22 5.8a8 8 0 0 1-2.4.7 4 4 0 0 0 1.8-2.2 8 8 0 0 1-2.6 1 4 4 0 0 0-6.8 3.6A11.4 11.4 0 0 1 3.2 4.6a4 4 0 0 0 1.2 5.3 4 4 0 0 1-1.8-.5v.1a4 4 0 0 0 3.2 4 4 4 0 0 1-1.8.1 4 4 0 0 0 3.7 2.8A8 8 0 0 1 2 18a11.3 11.3 0 0 0 6.1 1.8c7.4 0 11.4-6.1 11.4-11.4l-.01-.5A8 8 0 0 0 22 5.8z"/></svg>;
    case "telegram_post": return <svg {...p}><path d="M21 4 2 11l6 2 2 7 4-5 5 4z"/><path d="m8 13 8-5-5 7"/></svg>;
    case "discord_drop":  return <svg {...p}><path d="M17 4s2 2.5 2.5 6.5S20 18 20 18a13 13 0 0 1-3.5 1.5l-1-1.5"/><path d="M7 4S5 6.5 4.5 10.5 4 18 4 18a13 13 0 0 0 3.5 1.5l1-1.5"/><circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none"/></svg>;
    case "conference":    return <svg {...p}><circle cx="12" cy="7" r="3"/><path d="M5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/></svg>;
    case "talk":          return <svg {...p}><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>;
    case "press":         return <svg {...p}><path d="M4 4h13a2 2 0 0 1 2 2v12l-2-1.5L17 18l-2-1.5L13 18l-2-1.5L9 18l-2-1.5L5 18V4a2 2 0 0 1 1-2"/><path d="M8 8h7"/><path d="M8 12h7"/><path d="M8 16h4"/></svg>;
    case "post":          return <svg {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>;
    case "note":          return <svg {...p}><path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
    default:              return <svg {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>;
  }
}

const KIND_INFO = {
  youtube_video: { label: "YouTube video", color: "var(--k-youtube)"   },
  reddit_post:   { label: "Reddit post",   color: "var(--k-reddit)"    },
  twitter_post:  { label: "Twitter post",  color: "var(--k-twitter)"   },
  telegram_post: { label: "Telegram post", color: "var(--k-telegram)"  },
  discord_drop:  { label: "Discord drop",  color: "var(--k-discord)"   },
  conference:    { label: "Conference",    color: "var(--k-conference)"},
  talk:          { label: "Talk",          color: "var(--k-talk)"      },
  press:         { label: "Press mention", color: "var(--k-press)"     },
  post:          { label: "Post",          color: "var(--k-post)"      },
  note:          { label: "Note",          color: "var(--k-post)"      },
  other:         { label: "Other",         color: "var(--k-other)"     },
};

// ─── authors ────────────────────────────────────────────────────────────────
// Current user — matches the chip in the topbar.
const CURRENT_USER = { id: "u_me", name: "Adventpixel", initial: "A" };
// AUTHORS map + deriveAuthor() retired — multi-author UI is a future
// feature. Today every event is mine=true (current user) or mine=false
// (anonymous — empty neutral avatar).

// ─── mock data ───────────────────────────────────────────────────────────────
const GAMES = [
  { id: "g1", title: "Neonicle: Last Light",  color: "#E89B5E" },
  { id: "g2", title: "Dungeon Tactics",       color: "#7FB46A" },
  { id: "g3", title: "Silent Cartographer",   color: "#6FA0D1" },
];
const gameById = Object.fromEntries(GAMES.map((g) => [g.id, g]));

const EVENTS = [
  {
    id: "e01", kind: "press", date: "May 12", dateGroup: "Mon, May 12",
    title: "Rock Paper Shotgun — \"Neonicle is what Hollow Knight fans deserve\"",
    notes: "9-minute long-form review. Author played to credits. Wishlists +180 in 24h after publish.",
    src: "rockpapershotgun.com", gameIds: ["g1"], mine: false,
    thumb: null,
    stats: { reads: "9 min read" },
  },
  {
    id: "e02", kind: "reddit_post", date: "May 12", dateGroup: "Mon, May 12",
    title: "Show your screenshot Saturday — Dungeon Tactics co-op",
    notes: "32 upvotes, 14 comments. r/IndieGaming. Two commenters asked about Steam release date.",
    src: "r/IndieGaming", byline: "u/neonicle_dev", gameIds: ["g2"], mine: true,
    thumb: null,
    stats: { views: 32, likes: 32, comments: 14 },
  },
  {
    id: "e03", kind: "post", date: "May 12", dateGroup: "Mon, May 12",
    title: "Boulding #14 — WIP walk-around of Excavation",
    notes: null,
    src: "@neonicle_dev", gameIds: ["g1"], mine: true,
    thumb: null,
    stats: { likes: 42, comments: 8 },
  },
  {
    id: "e04", kind: "youtube_video", date: "Apr 30", dateGroup: "Thu, Apr 30",
    title: "Top 10 Upcoming Indie Games — Spring 2026",
    notes: "Featured at position 3. Channel has 84K subs. Spike of 240 wishlists from this video.",
    src: "VEVO",
    gameIds: ["g1"], mine: false,
    thumb: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=640&q=70",
    stats: { views: 120_000, likes: 3_200, comments: 384 },
    duration: "1:24",
  },
  {
    id: "e05", kind: "twitter_post", date: "Apr 29", dateGroup: "Wed, Apr 29",
    title: "Pixel art breakdown: how we paint our dungeons",
    notes: "Thread of 8 tweets. Quote-tweeted by @LudoCriticisms which is what drove the spike.",
    src: "@neonicle_dev", gameIds: ["g1"], mine: true,
    thumb: null,
    stats: { likes: 312, comments: 47 },
  },
  {
    id: "e06", kind: "discord_drop", date: "Apr 27", dateGroup: "Mon, Apr 27",
    title: "Drop #07 — playable build for Patrons",
    notes: "Shared early build of the demo. 84 active testers this cycle, 12 bug reports.",
    src: "Dungeon Tactics · #patreon-drops",
    gameIds: ["g2"], mine: true,
    thumb: null,
    stats: { likes: 84, comments: 12 },
  },
  {
    id: "e07", kind: "reddit_post", date: "Apr 25", dateGroup: "Sat, Apr 25",
    title: "Devlog: Tomorrow level design in sequence",
    notes: "Post-mortem & process. 65 upvotes, mixed comments. One commenter dunked on the parry timing.",
    src: "r/gamedev", byline: "u/neonicle_dev", gameIds: [], offTopic: true, mine: true,
    thumb: null,
    stats: { likes: 65, comments: 12 },
  },
  {
    id: "e08", kind: "press", date: "Apr 22", dateGroup: "Wed, Apr 22",
    title: "PC Gamer — \"12 indie games to watch this fall\"",
    notes: "Two-paragraph mention. Wishlists ticked up ~80 in the 48h after.",
    src: "pcgamer.com · 7 min read",
    gameIds: ["g1"], mine: false,
    thumb: null,
  },
  {
    id: "e09", kind: "youtube_video", date: "Apr 19", dateGroup: "Sun, Apr 19",
    title: "Dungeon Tactics — Demo gameplay",
    notes: "Mid-tier streamer plays the demo for 45 min. Wishlist +60 day-of.",
    src: "indie_critic_yt",
    gameIds: ["g2"], mine: false,
    thumb: "https://images.unsplash.com/photo-1542751110-97427bbecf20?w=640&q=70",
    stats: { views: 1_600, likes: 184, comments: 21 },
    duration: "3:45",
  },
  {
    id: "e10", kind: "talk", date: "Apr 16", dateGroup: "Thu, Apr 16",
    title: "Talk: \"Building atmosphere on a 12-month budget\"",
    notes: "Indie Devs Unplugged Podcast · Episode 128 · 56 min. Three questions about wishlist conversion.",
    src: "indie-devs-unplugged.fm",
    gameIds: ["g1"], mine: true,
    thumb: null,
  },
  {
    id: "e11", kind: "conference", date: "Apr 15", dateGroup: "Wed, Apr 15",
    title: "DevGAMM Minsk 2026 — Indie Showcase",
    notes: "Check out our September demo. Sep 11–12, 2026, Falanster, 400+ devs attending.",
    src: "devgamm.com",
    gameIds: ["g2"], offTopic: true, mine: true,
    thumb: null,
  },
  {
    id: "e12", kind: "post", date: "Apr 13", dateGroup: "Mon, Apr 13",
    title: "Email newsletter #02",
    notes: "Open rate: 42% · CTR: 6% (124 clicks). Sent to 8,241 subscribers.",
    src: "buttondown.email", gameIds: ["g1"], mine: true,
    thumb: null,
    stats: { reads: "Open rate 42%" },
  },
];

// ─── sources ────────────────────────────────────────────────────────────────
// Mock-list of connected data sources. Today's MVP supports two kind groups:
// YouTube channels and Reddit subs. Each source carries:
//   – kind: matches an EVENTS.kind (so reuse KIND_INFO color/icon)
//   – name: human-readable label
//   – handle: identifier (channel handle / subreddit / URL)
//   – author: 'mine' | 'others' — same one-bit signal as events
//   – active: bool — paused sources stop importing but stay listed
//   – lastSynced: human-readable timestamp string
//   – eventCount: how many events came from this source
const SOURCES = [
  { id: "s1", kind: "youtube_video", handle: "@indie_critic",     author: "others", active: true,  lastSynced: "12 min ago", eventCount: 3,  dateRange: "Apr 19 \u2013 May 12" },
  { id: "s2", kind: "youtube_video", handle: "@adventpixel",      author: "mine",   active: true,  lastSynced: "2 h ago",    eventCount: 14, dateRange: "Feb 04 \u2013 May 11" },
  { id: "s3", kind: "reddit_post",   handle: "r/IndieGaming",     author: "others", active: true,  lastSynced: "4 min ago",  eventCount: 22, dateRange: "Jan 22 \u2013 May 12" },
  { id: "s4", kind: "reddit_post",   handle: "r/gamedev",         author: "others", active: false, lastSynced: "3 days ago", eventCount: 7,  dateRange: "Mar 02 \u2013 Apr 25" },
];

// Group events by their .dateGroup field, preserving array order.
function groupedEvents(events) {
  const map = new Map();
  for (const ev of events) {
    if (!map.has(ev.dateGroup)) map.set(ev.dateGroup, []);
    map.get(ev.dateGroup).push(ev);
  }
  return [...map.entries()];
}

function fmt(n) {
  if (typeof n !== "number") return n;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

Object.assign(window, { I, KindIcon, KIND_INFO, GAMES, EVENTS, SOURCES, gameById, groupedEvents, fmt });
