---
created: 2026-05-05T12:30:00.000Z
area: frontend
status: pending
---

# Open Graph + Twitter Card meta tags for / and /about

## Idea

Add Open Graph (`<meta property="og:*">`) and Twitter Card
(`<meta name="twitter:*">`) tags to the canonical landing pages so
when users share `https://neotolis-diary.dev/` (or `/about`) on
Telegram, Twitter, Discord, Reddit, Slack, the link expands to a
rich preview with a controlled title + description + image.

Without OG tags, social platforms scrape the page heuristically and
often produce ugly previews (missing image, wrong title, just a bare
URL). With OG tags, the preview is consistent + branded across all
platforms.

## What to add

In `src/lib/components/AboutContent.svelte` `<svelte:head>` (which
renders for both `/` and `/about` since they use the shared
component):

```html
<!-- Open Graph (Facebook, LinkedIn, Telegram, Discord, Slack) -->
<meta property="og:title" content="Neotolis Diary — promotion log for indie devs" />
<meta property="og:description" content="A self-tracking diary across YouTube/Reddit/Telegram/conferences. Open source, MIT, self-host or use the canonical instance." />
<meta property="og:image" content="https://{data.domain}/og-image.png" />
<meta property="og:url" content="https://{data.domain}/" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Neotolis Diary" />

<!-- Twitter Card (X / Twitter — own standard, partial OG support) -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Neotolis Diary" />
<meta name="twitter:description" content="A self-tracking diary for indie game promotion" />
<meta name="twitter:image" content="https://{data.domain}/og-image.png" />
```

Plus design + ship a static `og-image.png`:

- Recommended size: 1200×630 px (Twitter `summary_large_image` minimum)
- Should show: project name, tagline, maybe a screenshot of the feed
- Place in `static/og-image.png` so SvelteKit serves it at
  `https://<DOMAIN>/og-image.png`
- Self-host operators get the same OG image automatically (no separate
  config) since it's a static asset shipped with the image

## Verification

After deploy, paste the URL into:

- Twitter card validator: <https://cards-dev.twitter.com/validator>
- Facebook OG debugger: <https://developers.facebook.com/tools/debug/>
- Or just paste into Telegram and see the preview live (Telegram caches
  for ~24h — debugger can force refresh)

## Why this isn't urgent

- The Reddit launch post + Twitter post + Telegram post already shipped
  on 2026-05-04 without OG tags
- Telegram and Reddit fall back to heuristics that work OK for plain
  text (they pulled title from `<title>` correctly)
- The bigger win is for any future shares (when someone in v0.2/v0.3
  passes around the project URL)

## Estimated work

- ~15-20 min for the meta tags themselves
- ~30-60 min for designing a decent og-image.png (Figma / Canva quick
  job, or AI-generated placeholder)
- + verification across the 3 main platforms

Total: ~30-90 min depending on how polished the og-image is.

## When to do this

Anytime, low priority. Fits well as a Phase 3-side polish task or a
standalone `chore/og-tags` PR before publishing to wider audiences.
Pick up before any major v0.2 / v0.3 launch where the URL gets shared
heavily.

## Captured

2026-05-05 during Phase 3 milestone start. Not in original Phase 02.2
scope. User noted it as "polish that helps sharing" — agent-suggested
during launch-post drafting.
