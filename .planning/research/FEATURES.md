# Feature Research

**Domain:** Indie game developer promotion-tracking SaaS (multi-tenant + open-source self-host parity)
**Researched:** 2026-04-27
**Confidence:** MEDIUM-HIGH (table stakes & anti-features verified against multiple competitor surveys; Reddit rules differentiator deeply analyzed; Steam Web API permission shape confirmed against Steamworks docs)

## Executive Framing

The competitive landscape splits into four buckets, none of which directly serve the use case described in PROJECT.md:

1. **Steamworks built-ins** (Wishlist Reporting, UTM, Sales & Activation portal) — authoritative wishlist data, but **no event/promotion log overlay**, no Reddit/YouTube data, no cross-game view, and no way to export/snapshot history outside of Steam's own UI.
2. **Market-intelligence dashboards** (GameDiscoverCo Pro, VG Insights, SteamDB charts, IMPRESS' Steam analytics) — competitor benchmarking and macro-trend reports for *other* games. Not a personal diary; not a place where you log *your* Reddit post and watch your *own* wishlist line move.
3. **Indie marketing toolkits** (IMPRESS, Coverage Bot, Press Kitty, Launchpad) — strongest analog. Cover **influencer discovery, key distribution, coverage detection, press kit hosting**. Sit on top of Twitch/YouTube/TikTok scraping. But: oriented around *outreach campaigns* (push), not around *the dev's own promotion diary* (pull-and-correlate). No Reddit-rules surfacing. No first-class "annotated wishlist timeline".
4. **Generic social analytics** (Buffer, Hootsuite, Metricool, Sprout) — schedulers and post-performance trackers. Cross-platform but **game-blind**: they don't know what a wishlist is, can't correlate to Steam, and their core feature (auto-posting) is exactly what PROJECT.md rules out.
5. **Reddit-compliance tools** (RedChecker, RedShip, RedditReady, Reddit's own Rule Check) — closest analog for the **subreddit-rules differentiator**. Aim at "will my post get removed?" but are not game-aware and don't snapshot post performance over time.

**Net:** the diary niche — *single game-dev, log a URL, watch metrics evolve, overlay against my own wishlist line, with subreddit-aware posting hygiene baked in* — is **structurally unserved**. Competitors either point outward (find creators, post to socials) or specialize in one slice (just shadowban check, just wishlist report). That's the opening.

## Feature Landscape

### Table Stakes (Users Expect These)

These are the floor. If any are missing, the user keeps the spreadsheet — because the spreadsheet at least covers them implicitly.

| # | Feature | Why Expected | Complexity | Notes |
|---|---------|--------------|------------|-------|
| TS-01 | **Multiple games per account** with per-game cards (title, Steam URL, cover, release date, genres, free-form notes) | Every spreadsheet user has rows-per-game; an indie dev typically has 1 shipped + 1 WIP + 1 prototype | S | Already locked in PROJECT.md. Cover image can be lazy-fetched from Steam store API (`appdetails`) |
| TS-02 | **Paste a URL → service tracks it forever** (Reddit post, YouTube video) | Core mental model: "I add a thing, system watches it." Without this, app is just a fancy form | M | Hybrid ingestion already locked. Requires URL parser per platform + adaptive poller |
| TS-03 | **Per-item metric history with line chart** (upvotes/comments over time, views over time) | Otherwise this is a bookmark manager, not an analytics tool | M | Requires `metric_snapshots` table; chart with a basic line viz (Chart.js / Recharts class) |
| TS-04 | **Wishlist line over time** with daily granularity | Wishlists are THE dominant indie KPI — Steam Next Fest correlates r=0.825 with prior wishlist accumulation. Showing a flat "you have 1,247" number is useless | M | Two ingest paths: (a) optional Steam Web API key auto-pull via `IWishlistService.GetWishlistItemCount` / Wishlist Reporting API; (b) manual / CSV import from Steamworks `Wishlists.csv` export. Both already locked |
| TS-05 | **Combined per-game timeline** — own actions, blogger coverage, and wishlist line on **one chart** | This is the actual reason a spreadsheet fails: you can't easily eyeball "did the Reddit post move the wishlist line?" | M | Single chart with annotations/event markers; depends on TS-03 + TS-04 |
| TS-06 | **Add YouTube videos and distinguish own vs. blogger coverage** | Bloggers playing your game is a separate funnel from your devlog. Lumping them together hides the signal | S | One enum field. Per-channel grouping in UI |
| TS-07 | **Per-item detail view** (e.g., a single Reddit post page with full snapshot history, comment count graph, link-out) | Without drill-down, the timeline becomes the only view and gets cluttered | S | Already locked |
| TS-08 | **Free-form events timeline** (conferences, talks, Twitter posts, TG posts, Discord drops) | Marketing happens off-API too; if events can't be logged, the timeline lies. Twitter API is paywalled out anyway | S | Manual entries with title, date, optional URL, optional notes. Already locked |
| TS-09 | **Authentication via Google OAuth** | Modern SaaS expectation; locked-in as MVP-only | S | Already locked |
| TS-10 | **Per-user encrypted API key storage** with write-once UI (last-4 only) | Without it, users can't bring their own YouTube/Reddit/Steam keys safely | M | Envelope encryption (KEK env, DEK per row) already locked |
| TS-11 | **CSV / JSON export of all data** | Lock-in fear is the #1 reason indies don't switch off spreadsheets. Export must exist on day one | S | Per-game export endpoint; export = audit-logged |
| TS-12 | **Audit log visible to owner** (logins, IPs, key add/remove, exports) | Privacy promise needs visible enforcement. Already locked | S | Append-only table, simple list view |
| TS-13 | **Dark/light mode** | 2026 baseline; indie devs work at night | S | CSS-vars + `prefers-color-scheme` |
| TS-14 | **Mobile-readable view** (responsive — not native app) | Devs check stats from phone after posting | S | Responsive layout; charts must render <600px |
| TS-15 | **Empty states with copy-paste examples** ("Paste a Reddit post URL like `https://reddit.com/r/IndieDev/...`") | Indies will abandon if first-touch is "where do I even start" | S | Just UX writing; no extra infra |

### Differentiators (Competitive Advantage)

These are why someone picks this over `spreadsheet + RedChecker + Steamworks tab + Buffer trial`. Aligned to PROJECT.md "Core Value": **see at a glance which promotion actions actually moved the needle.**

| # | Feature | Value Proposition | Complexity | Notes |
|---|---------|-------------------|------------|-------|
| **D-01** | **Subreddit Rules Cockpit** — for each tracked subreddit, store: (a) raw rules text auto-pulled from Reddit API `/r/{sub}/about/rules`, (b) user-curated structured fields (cooldown days, allowed flairs, min karma, min account age, megathread-only flag, banned-on-self-promo), (c) "last posted N days ago" countdown per subreddit-per-game | **No competitor has this for game devs.** RedChecker exists for general lead-gen but isn't game-aware. This directly prevents shadowbans, which is the existential risk that destroys a launch | **L** | Hybrid required because Reddit's rules API only returns the `short_name`/`description` text, NOT structured cooldown/flair-required fields — those must be human-curated. **This is THE feature that justifies the whole product.** Bundle sane defaults for top indie subs (r/IndieDev, r/IndieGaming, r/indiegames, r/playmygame, r/WebGames, r/DestroyMyGame, r/godot, r/Unity3D, r/Unity2D, r/unrealengine) so first-time users are protected from day one |
| **D-02** | **Pre-post warning UI** — when user pastes a Reddit URL or clicks "log a planned post", check structured rules: cooldown elapsed? flair allowed? promo cap not breached? Show a traffic-light verdict (green/yellow/red) with the violated rule highlighted | Stops the disaster before it happens. RedChecker's core value prop, applied to game devs | M | Depends on D-01. UI is straightforward; the value is in the curated rule database. Must NOT auto-block — user can always override (they know their community better than any rule table) |
| **D-03** | **Annotated wishlist correlation chart** — single chart showing wishlist daily-adds line + every promotion event as a vertical marker; click marker → side panel with that event's metrics | Spreadsheets cannot do this. Steamworks won't do this. GameDiscoverCo benchmarks *other* games. This is the literal answer to the question "which post moved the needle?" | M | Depends on TS-03 + TS-04 + TS-05. The single most defensible UX in the product. Marker tooltips show delta-wishlists in the 24h/7d window after the event |
| **D-04** | **"Cold start" curated subreddit rule database** shipped with the product | A spreadsheet replacement is unattractive if you have to populate it yourself. Shipping pre-curated rules for the top ~25 indie subreddits = product feels useful before any user input | M | One-time content effort + maintenance. Stored as seed data + per-instance overrides. Self-hosters inherit the same seeds. Open-source angle: PRs to add/update rules become a community contribution path |
| **D-05** | **Multi-channel-per-game model** — register multiple YouTube channels, multiple TG channels, multiple Twitter handles per game | A studio with both `@studioName` and `@gameName` accounts can't model this in spreadsheets without giving up. Most generic tools assume 1 brand = 1 set of accounts | S | Already locked. Just a `game_channels` join table. Differentiator because competitors specifically don't do it well |
| **D-06** | **"Hot/warm/cold" adaptive polling** with user-visible status badge per item | Competitors either over-poll (burn API quota → user's quota dies → trust dies) or under-poll (data feels stale). Visible adaptive polling tells the user "we're still watching this, just less often." Trust signal | M | Already locked. Surface it: badges like "Hot — checked 12m ago", "Warm — every 6h", "Cold — daily". Per-item user override ("track this hourly for 7 more days") |
| **D-07** | **First-class blogger-coverage tracking** — log a YouTube/Twitch URL flagged "blogger", store channel name, subscribers-at-time-of-coverage, view history, total-views-from-this-creator across all your games | Coverage Bot does discovery, not retention/history. Spreadsheet tracking of "who covered me" loses the momentum data. This becomes the dev's personal "creators who got me wishlists" dataset | M | Depends on TS-06. Adds: `creator` table (one row per channel) + `coverage_event` (links creator → game → video). Cross-game view unlocks "do I have a recurring fan?" insight |
| **D-08** | **Open-source self-host parity** with single Docker-compose | Privacy-paranoid devs (the security-conscious indie segment) won't trust a SaaS with their wishlist data. Offering self-host with identical features is a moat against any future closed-source clone | M | Already locked. Differentiator vs. IMPRESS, Coverage Bot, GameDiscoverCo (all closed SaaS). License (MIT) and identical-codebase guarantee already locked |
| **D-09** | **Bring-your-own API key model** with per-key quota dashboard | Indies trust quota visibility. Pooling under one app key (which most SaaS do) = a single noisy user kills everyone's polling. BYO key + per-key health UI = the user can self-diagnose | M | Already locked. Surface daily quota usage per key (YouTube: units used today, Reddit: requests used in last hour). Warning at 80% |
| **D-10** | **Calendar-grid heatmap of "promotion intensity"** — shows what days you posted in each channel (Reddit / YouTube / events) for the last 90 days | Helps detect promotion droughts (the silent killer). Generic social tools don't unify Reddit+YouTube+conferences in one heatmap | S | Single SQL `GROUP BY date_trunc('day', ...)` over the events table. Renders in any heatmap library. High-impact, low-effort |
| **D-11** | **Per-game tag-able "campaign" grouping** (e.g., tag a Reddit post + 3 events + a YouTube video as `campaign:next-fest-2026`), then filter timeline by campaign | Once a dev has 200+ events, the timeline is unreadable. Campaign tags = the way they actually think ("did Next Fest work?"). No competitor offers this for indie game promotion | M | Many-to-many tag table; multi-select filter on timeline. Modest infra, big DX win |
| **D-12** | **"What's stale?" inbox** — surface items where polling last succeeded >48h ago (auth expired, video deleted, post removed) | Silent data rot is what makes spreadsheets unreliable. Making it visible builds trust | S | Cron query against `metric_snapshots`. Surfaces in nav badge |

### Anti-Features (Commonly Requested, Often Problematic)

Things the user (or future user) will ask for that we should explicitly *not* build, with concrete reasoning. PROJECT.md already locks several; this section adds a few more that aren't locked yet, and explains the locked ones with stronger anti-feature framing so future scope-creep requests can be answered cleanly.

| # | Anti-Feature | Why Requested | Why Problematic | Alternative |
|---|---|---|---|---|
| AF-01 | **Auto-posting to Reddit / YouTube / Telegram** | "If you already have my key, why not let me post from here?" Buffer/Hootsuite parity envy | (a) Reddit specifically punishes account-cloned posting patterns → shadowban risk against the user's own account; (b) any auto-poster must be classified as a "third-party app" under Reddit's Responsible Builder Policy with stricter API access; (c) creates massive support surface ("why didn't my post go up?"); (d) directly contradicts the privacy-only / read-only social posture | Stay strictly read-only on social. User posts manually. Service tracks. This **is** the product's posture, not a missing feature |
| AF-02 | **Public dashboards / shareable game pages** | "I want to send this to my publisher / show off wishlist growth on Twitter" | Wishlist + sales data is commercially sensitive (NDAs with publishers, investor optics, competitive intel). One leaked page or incorrect ACL is a category-extinction event. Locked out of MVP | Deferred to v2 share-link model with explicit per-link scope, expiry, and audit trail. Already locked in PROJECT.md |
| AF-03 | **Steam page scraping** for wishlists / followers / reviews when no API key is provided | "Just scrape it like SteamDB does" | (a) Violates Steam ToS for high-frequency scraping by third parties on behalf of users; (b) gets the SaaS's IPs banned, breaking everyone; (c) self-hosters might be okay with this but the SaaS instance can't take the risk. Manual CSV import is the honest fallback | Two paths only: (a) optional Steam Web API key (auto-pull, fully sanctioned); (b) manual entry / CSV import from the Steamworks-provided `Wishlists.csv` export. Already locked |
| AF-04 | **Auto-discovery of mentions** ("find all YouTubers/Redditors talking about my game") | Coverage Bot does this; it feels like table stakes | (a) Cost: requires running constant search queries — YouTube `search.list` is 100 quota units per call vs. 1 for `videos.list`; would burn the user's 10k/day cap in minutes; (b) the SaaS doing it server-side hits Coverage-Bot-tier infra cost (paid Twitch API, paid TikTok scrape services); (c) requires fuzzy game-title matching that produces noisy false positives | User pastes URLs they already know about. v2 can add discovery as a separate paid tier. Already locked out of MVP |
| AF-05 | **Twitter/X API tracking** | Twitter is still where indie devs post; "of course you should track tweets" | Twitter Basic API is $100/mo with 10k-tweets/month read cap — uneconomical for an indie tool, especially per-tenant. Self-host can't even guarantee a key exists | Twitter posts logged manually as timeline events. Already locked. Restate this when users ask |
| AF-06 | **Telegram channel auto-tracking** (Bot API or MTProto) | Russian/EU indie scene leans heavily on TG | Bot API requires the bot to be added as channel admin (privacy invasive on the user's audience); MTProto is per-user-account auth, fragile, and easily looks like spam to TG. Either way, lots of complexity for minor signal | Telegram entries are manual timeline events in MVP. Already locked. Reconsider in v2 once TG channel-stats API stabilizes |
| AF-07 | **In-app TOTP / 2FA** | "Security tool should have 2FA" | Adds password reset flows, recovery codes, lost-2FA support burden. Google OAuth already enforces Google's 2FA on the only login path. Building parallel 2FA = duplicating Google's stack at zero added security | Google OAuth-only is the security stance. Already locked |
| AF-08 | **Email / password / GitHub auth** | "What if I don't have a Google account?" | Each auth method = own attack surface (password resets, credential stuffing, account-takeover flows). Indie devs all have Google accounts (YouTube ties to Google) | Google OAuth-only. Already locked |
| AF-09 | **Public catalog of indie games being promoted on the platform** | "Cool social proof — and SEO" | Reveals which devs are using the tool, and (worse) exposes indirect signals about their wishlist health to competitors. Privacy-only is the pitch | Marketing site uses opt-in testimonials only. No autogenerated catalog |
| AF-10 | **Real-time WebSocket "wishlist counter"** | Looks impressive in demos | Steam wishlist data updates daily at best (Steamworks reports; partner API has lag). A real-time counter would be theatrically real-time but factually wrong. Wastes infra | Daily granularity is the truth. Show "last updated: Xh ago" honestly |
| AF-11 | **Built-in AI suggestions for "what to post next"** | ChatGPT-everywhere energy | (a) LLM API costs per tenant for a free-tier-only product; (b) generic advice provides no edge over public ChatGPT; (c) hallucination risk on subreddit rules is catastrophic — exactly the failure mode D-01/D-02 are designed to prevent | If an AI feature ever lands, it must be an opt-in self-host prompt with the user's own key, surfacing curated rules — never generating them |
| AF-12 | **Native mobile app** (iOS/Android) | "Indie devs check stats from phone" | Doubles maintenance, requires App Store / Play Store accounts, breaks the "small VPS + Cloudflare Free" cost story. App stores' review processes are fatal to a solo-dev shipping cadence | Responsive web. Add a manifest + service worker for "Add to Home Screen" if anyone asks. Already implied by TS-14 |
| AF-13 | **Public leaderboards / "top promoted indie games this week"** | Gamification, viral hook | Same problem as AF-09 plus actively incentivizes vanity-metric chasing — exactly what wayline.io and the IGN piece warn against | Personal-stats-only. Period |
| AF-14 | **Generic project-management features** (kanban, sprint board, todos) | "Codecks/ClickUp/Trello are nice; bundle that in" | Massive scope creep into a saturated category we can't beat. Distracts from the wishlist-correlation niche | Single-purpose tool. Integrate later only if a clean export/import to Codecks et al. is requested |
| AF-15 | **Per-game custom domains / white-label** | Studio-tier pricing dream | Pulls infra into multi-tenant TLS automation, billing tiers, branding pipeline. v3+ at earliest | Stay single-host SaaS with self-host as the white-label path |

## Feature Dependencies

```
TS-01 game cards (foundation)
   ├──> TS-02 URL ingest
   │       ├──> TS-03 per-item metric history
   │       │       └──> TS-07 per-item detail view
   │       │       └──> D-06 hot/warm/cold polling badges
   │       │       └──> D-12 "what's stale" inbox
   │       └──> TS-06 own-vs-blogger distinction
   │               └──> D-07 first-class blogger coverage tracking
   ├──> TS-04 wishlist line over time
   │       └──> TS-05 combined timeline (REQUIRES TS-03 + TS-04)
   │               └──> D-03 annotated correlation chart
   ├──> TS-08 free-form events timeline
   │       └──> D-10 promotion-intensity heatmap (needs TS-02 + TS-06 + TS-08 unified)
   │       └──> D-11 campaign tag grouping
   ├──> TS-09 Google OAuth
   │       └──> TS-10 encrypted key storage
   │               └──> D-09 per-key quota dashboard
   ├──> TS-11 CSV/JSON export
   ├──> TS-12 audit log
   └──> D-05 multiple channels per game (extends TS-01)

D-01 subreddit rules cockpit
   ├──> needs Reddit OAuth in TS-10
   ├──> needs D-04 curated rules seed database
   └──> D-02 pre-post warning UI (REQUIRES D-01)

TS-13 dark mode, TS-14 mobile responsive, TS-15 empty states  --> independent UI concerns
D-08 OSS self-host parity  --> deployment / packaging (cuts across all features)
```

### Dependency Notes

- **TS-05 (combined timeline) requires TS-03 + TS-04**: the chart is just rendering on top of `metric_snapshots` (per-item) joined with `wishlist_snapshots` (per-game-day). Can't ship before both ingest paths exist.
- **D-03 (annotated correlation chart) requires TS-05**: it's the same chart with annotations layer. Build TS-05 first (raw lines work), add markers second.
- **D-01 (rules cockpit) requires Reddit OAuth in TS-10**: only authenticated requests can hit `/r/{sub}/about/rules` reliably and at sane rate-limits.
- **D-02 (pre-post warning) requires D-01 + D-04**: warnings are useless without curated rule data; curated data is useless without UI to query it.
- **D-04 (curated rules) is content, not code**: it can be authored in parallel with D-01 by anyone, including community contributors via the OSS repo. Schema must be locked first though.
- **D-09 (per-key quota) requires TS-10**: needs the keys to exist before showing usage stats.
- **D-12 ("what's stale" inbox) requires D-06 (adaptive polling)**: both observe the same `last_polled_at` field; D-06 *writes* it, D-12 *reads* it. They ship as a pair.
- **D-07 (blogger coverage as a first-class entity) extends TS-06**: TS-06 is just a flag; D-07 promotes it into a full `creator` table. TS-06 ships first; D-07 is a refactor.
- **D-11 (campaign tags) is independent of metric ingest**: it's a UX layer over events. Ship anytime after TS-05.
- **D-10 (heatmap) needs TS-02 + TS-06 + TS-08 all to be feeding the same events stream**: ship after the events table is unified.

## MVP Definition

### Launch With (v1)

The minimum that beats the spreadsheet. If any of these is missing, the user keeps the spreadsheet.

- [ ] **TS-01** Game cards (multi-game, per-game cards) — *foundation; spreadsheet replacement is impossible without this*
- [ ] **TS-02** Paste-URL ingest for Reddit posts and YouTube videos — *core mental model; the entire pull-and-correlate posture rests on this*
- [ ] **TS-03** Per-item metric history with line chart — *otherwise just a bookmark manager*
- [ ] **TS-04** Wishlist line over time (Steam Web API key path AND CSV import path) — *this is the indie KPI; both paths must work or risk-averse devs can't onboard*
- [ ] **TS-05** Combined per-game timeline — *the single chart is the actual product*
- [ ] **TS-06** Own-vs-blogger distinction on YouTube — *signal hygiene; cheap to add*
- [ ] **TS-07** Per-item detail view — *drill-down*
- [ ] **TS-08** Free-form events timeline — *manual entries for Twitter/TG/conferences; the API-less channels still need a place to live*
- [ ] **TS-09** Google OAuth login
- [ ] **TS-10** Per-user encrypted API key storage with write-once UI
- [ ] **TS-11** CSV/JSON export — *unlocks switching cost; non-negotiable for anti-lock-in trust*
- [ ] **TS-12** Audit log
- [ ] **TS-13/TS-14/TS-15** Dark mode, responsive, empty states — *baseline UX*
- [ ] **D-01** Subreddit Rules Cockpit (raw text + structured fields) — *this is the differentiator; without it, MVP is "another spreadsheet replacement" with no moat*
- [ ] **D-03** Annotated wishlist correlation chart — *the headline screenshot of the product*
- [ ] **D-04** Curated rule seed database for top ~10 indie subreddits — *makes D-01 useful on day one*
- [ ] **D-05** Multiple channels per game — *already locked; cheap*
- [ ] **D-06** Hot/warm/cold polling with visible badges — *trust signal; the polling worker is built anyway*
- [ ] **D-08** Self-host parity (Docker-compose, MIT) — *required by PROJECT.md, distinguishes from every closed-SaaS competitor*
- [ ] **D-09** Per-key quota dashboard — *quota anxiety is real; surfacing it builds trust*

### Add After Validation (v1.x — within first 3-6 months post-launch)

These are the "thank-you" features that convert satisfied users into evangelists, but aren't required to validate the concept.

- [ ] **D-02** Pre-post Reddit warning UI — *trigger: at least one user reports a near-shadowban averted by manually checking the rules cockpit*
- [ ] **D-07** First-class blogger coverage entity (creator table, cross-game view) — *trigger: users start asking "which YouTuber drives the most wishlists across my catalog?"*
- [ ] **D-10** Promotion-intensity heatmap — *trigger: users hit ~6 months of data and the timeline becomes unreadable*
- [ ] **D-11** Campaign tag grouping — *trigger: same as D-10 — readability of dense timelines*
- [ ] **D-12** "What's stale" inbox — *trigger: users start missing that some items stopped polling silently*
- [ ] **D-04 expansion**: curated rules grow from ~10 to ~25+ subreddits, accept community PRs

### Future Consideration (v2+)

Defer until product-market fit, paying users, or a specific request volume justifies the scope.

- [ ] Public share-link reports (deferred from AF-02 scope) — *the read-only investor/publisher share view*
- [ ] Auto-discovery of mentions (AF-04 reversal at scale) — *paid tier; the cost economics only work above a price floor*
- [ ] Twitter/X API tracking (AF-05 reversal if Twitter pricing ever changes)
- [ ] Telegram channel auto-tracking (AF-06)
- [ ] Multi-language UI beyond English
- [ ] Discord server analytics (server-stats integration)
- [ ] Steam follower count tracking (separate from wishlists; same ingest pattern)

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| TS-01 game cards | HIGH | LOW | P1 |
| TS-02 URL ingest | HIGH | MEDIUM | P1 |
| TS-03 metric history | HIGH | MEDIUM | P1 |
| TS-04 wishlist line | HIGH | MEDIUM | P1 |
| TS-05 combined timeline | HIGH | MEDIUM | P1 |
| TS-06 own-vs-blogger flag | MEDIUM | LOW | P1 |
| TS-07 per-item detail | MEDIUM | LOW | P1 |
| TS-08 events timeline | HIGH | LOW | P1 |
| TS-09 Google OAuth | HIGH | LOW | P1 |
| TS-10 encrypted keys | HIGH | MEDIUM | P1 |
| TS-11 export | HIGH | LOW | P1 |
| TS-12 audit log | MEDIUM | LOW | P1 |
| TS-13/14/15 UX baseline | MEDIUM | LOW | P1 |
| **D-01 rules cockpit** | **HIGH** | **HIGH** | **P1** |
| **D-03 annotated chart** | **HIGH** | **MEDIUM** | **P1** |
| D-04 rule seed DB | HIGH | MEDIUM | P1 |
| D-05 multi-channel | MEDIUM | LOW | P1 |
| D-06 polling badges | MEDIUM | LOW | P1 |
| D-08 self-host parity | HIGH | MEDIUM | P1 |
| D-09 quota dashboard | MEDIUM | LOW | P1 |
| D-02 pre-post warning | HIGH | MEDIUM | P2 |
| D-07 creator entity | HIGH | MEDIUM | P2 |
| D-10 heatmap | MEDIUM | LOW | P2 |
| D-11 campaign tags | MEDIUM | MEDIUM | P2 |
| D-12 stale inbox | MEDIUM | LOW | P2 |
| Public share-links | MEDIUM | HIGH | P3 |
| Auto-discovery | HIGH | HIGH | P3 |
| TG / Twitter auto-track | MEDIUM | HIGH | P3 |
| Multi-language UI | LOW | MEDIUM | P3 |

**Priority key:**
- P1: Must have for v1 launch
- P2: Add within 3-6 months post-launch based on usage signals
- P3: Future consideration, deferred until clear demand or economics shift

## Competitor Feature Analysis

| Feature | Steamworks built-in | GameDiscoverCo / VG Insights | IMPRESS / Coverage Bot | Buffer / Hootsuite / Metricool | RedChecker / RedShip | **Our Approach** |
|---|---|---|---|---|---|---|
| Wishlist daily-adds chart | Yes (UI only, no API export until 2026) | Estimates only | Estimates only | No | No | Yes — auto-pull via key OR CSV import; daily snapshots in our DB |
| Reddit post tracking | No | No | No | Yes (post performance) | Partial | Yes — full snapshot history per post |
| YouTube video tracking | No | No | Coverage detection only | Yes (own posts) | No | Yes — own + blogger, distinguished |
| Subreddit rules surfacing | No | No | No | No | **Yes** (general) | **Yes** (game-specific, curated seed DB) — the differentiator |
| Annotated wishlist timeline | No | No | No | No | No | **Yes** — D-03, our headline feature |
| Auto-posting / scheduling | No | No | No | **Yes** | No | **No** (anti-feature AF-01) |
| Auto-discovery of mentions | No | Macro trends only | Yes (Coverage Bot) | No | No | **No** in MVP (AF-04); v2 paid tier |
| Public dashboards | No | No | Some (creator-side) | Some | No | **No** (privacy-only; AF-02) |
| BYO API keys | N/A | No | No | No | No | **Yes** (D-09, the quota model) |
| Self-host / OSS | No | No | No | No | No | **Yes** (MIT, Docker-compose; D-08) |
| Multi-game per account | Yes (per app) | N/A (read-only) | Yes | Multi-brand | Per-account | Yes (TS-01) |
| Free-form events / conferences | No | No | Partial (campaigns) | No | No | Yes (TS-08) |
| Pricing for indies | Free | $$ subscription | Free + paid tier | $$ per seat | $ subscription | Free SaaS + free self-host (cost-sensitivity locked in PROJECT.md) |

**Reading:** No single competitor occupies the wishlist-correlation + Reddit-rules + multi-channel-diary niche. Each gets one slice, none integrate. That's the open lane.

## Confidence & Verification Notes

- **HIGH confidence:** competitor feature gaps (verified across multiple sources for each); Steamworks wishlist API shape (confirmed against partner.steamgames.com docs); YouTube quota economics (10k units/day, `videos.list`=1, `search.list`=100 — confirmed against developers.google.com).
- **MEDIUM confidence:** Reddit `/about/rules` endpoint shape — couldn't fetch reddit.com directly via WebFetch (blocked). Confirmed via secondary docs (apidog, latenode, zuplo) that the endpoint exposes raw rule text/short-name only, not structured cooldown/flair-required fields. **Recommend Phase-1 spike to validate the exact JSON schema before locking D-01 data model.**
- **MEDIUM confidence:** the curated rule seed list of "top ~10 indie subreddits" — based on cited subscriber counts (r/IndieGaming 390K, r/indiegames 235K) and 2025 marketing-guide consensus. Final list should be revisited with the author who knows the indie scene firsthand.
- **LOW confidence:** specific RedChecker feature set (vendor doesn't publish a detailed feature page; relied on launch announcement + indie-hackers post). Direction of differentiation is sound; feature parity claims should be sanity-checked if D-02 ships.

## Sources

- [GameDiscoverCo: State of Steam Wishlist Conversions 2024-2025](https://newsletter.gamediscover.co/p/the-state-of-steam-wishlist-conversions)
- [IMPRESS — Indie game marketing toolkit](https://impress.games/)
- [IMPRESS Changelog — Coverage Bot, rolling metrics, Twitch](https://impress.games/changelog/coverage-bot-rolling-metrics-twitch)
- [VG Insights — Steam Analytics platform](https://vginsights.com/steam-analytics)
- [SteamDB — wishlist charts, leaderboards, API](https://steamdb.info/stats/mostwished/)
- [Steamworks — Wishlist Reporting docs](https://partner.steamgames.com/doc/marketing/wishlist/reporting)
- [Steamworks — Wishlist Data API announcement](https://steamcommunity.com/groups/steamworks/announcements/detail/499474120884358024)
- [Steamworks — UTM tracking for wishlists & sales](https://howtomarketagame.com/2021/04/14/how-to-use-steams-utm-feature-to-track-the-number-of-wishlists-and-sales-your-marketing-is-generating/)
- [steam-wishlist-pulse — open-source Wishlist Data API client](https://github.com/hortopan/steam-wishlist-pulse)
- [How to Market a Game on Reddit — CloutBoost 2025](https://www.cloutboost.com/blog/how-to-market-a-video-game-on-reddit-the-complete-2025-guide-for-game-developers)
- [How to Promote Indie Game on Reddit Without Losing Your Sanity — IMPRESS](https://impress.games/blog/how-to-promote-your-indie-game-on-reddit)
- [Don't Get Downvoted — Game Developer](https://www.gamedeveloper.com/business/don-t-get-downvoted-some-tips-for-promoting-your-indie-game-on-reddit)
- [RedChecker — Reddit lead-gen & compliance tool](https://www.redchecker.io)
- [RedShip — Free Subreddit Rules Checker](https://redship.io/free-tools/subreddit-rules-checker)
- [Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
- [Reddit API Limits & Posting Restrictions — Postiz](https://postiz.com/blog/reddit-api-limits-rules-and-posting-restrictions-explained)
- [Reddit Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
- [YouTube Data API v3 — Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
- [Steam Next Fest wishlist correlations — How To Market A Game](https://howtomarketagame.com/2025/03/26/benchmarks-how-many-wishlists-can-i-get-from-steam-next-fest/)
- [Buffer / Hootsuite / Metricool feature comparisons](https://buffer.com/resources/social-media-scheduling-tools/)
- [Indie Game Marketing Survival Guide — Wayline](https://www.wayline.io/blog/indie-game-marketing-survival-guide)
- [Indie Game Distribution & UA Painpoints 2025-2026 — MetricUS](https://metricusapp.com/blog/indie-game-distribution-user-acquisition-painpoints-2025-2026/)

---
*Feature research for: indie game promotion-tracking SaaS*
*Researched: 2026-04-27*
