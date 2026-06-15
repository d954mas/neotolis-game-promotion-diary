// News content service. Reads author/AI-written HTML articles committed under
// src/content/news/ and exposes them to the public /news routes.
//
// Why HTML, not markdown: the posts are written by the author (or an AI
// assistant) and committed to the repo — a trusted, code-reviewed source, not
// user input. Rendering author HTML directly needs ZERO dependencies (no
// markdown parser) and keeps each post self-contained. The {@html} sink that
// renders `body` is safe precisely because this content never crosses a tenant
// boundary — it is the same for every visitor and authored by us.
//
// Each file is `YYYY-MM-DD-<slug>.html` with a small frontmatter envelope:
//
//   ---
//   title: ...
//   date: YYYY-MM-DD
//   summary: ...
//   ---
//   <article body as HTML>
//
// The date prefix on the filename is for human ordering only; the authoritative
// date is the frontmatter `date`. The slug (the URL) is the filename minus that
// prefix and the extension.
//
// Images / media: drop the asset under static/ and reference it by absolute URL
// in the body, e.g. `<img src="/news-media/<slug>/cover.webp" width=.. height=..>`
// (mirrors static/landing/*.webp). Use static/news-media/, NOT static/news/ —
// the latter would shadow the /news/<slug> route. The article .prose styles
// (src/routes/news/[slug]/+page.svelte) handle <img>/<figure>/<figcaption>.

export type NewsMeta = {
  slug: string;
  /** ISO YYYY-MM-DD — for `<time datetime>` and sorting. */
  date: string;
  /** "Jun 14, 2026" — pre-formatted (en-US, UTC) for display. */
  dateDisplay: string;
  title: string;
  summary: string;
  /** Absolute URL of the cover image (e.g. /news-media/<slug>/cover.webp), or
   *  null when the post has no `cover:` frontmatter. */
  cover: string | null;
  coverAlt: string;
};

export type NewsPost = NewsMeta & { body: string };

// Vite inlines every matching file as a raw string at build time, so there is
// no filesystem read at request time and the content ships in the server bundle.
const FILES = import.meta.glob("/src/content/news/*.html", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function slugFromPath(path: string): string {
  const base = path.split("/").pop()!.replace(/\.html$/, "");
  return base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

function parsePost(path: string, raw: string): NewsPost {
  const match = FRONTMATTER.exec(raw);
  if (!match) throw new Error(`news: ${path} is missing its --- frontmatter --- envelope`);
  const [, frontmatter = "", body = ""] = match;

  const meta: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }

  const date = meta.date ?? "";
  const cover = meta.cover && meta.cover.length > 0 ? meta.cover : null;
  return {
    slug: slugFromPath(path),
    date,
    dateDisplay: date ? DATE_FORMAT.format(new Date(`${date}T00:00:00Z`)) : "",
    title: meta.title ?? "(untitled)",
    summary: meta.summary ?? "",
    cover,
    coverAlt: meta.coverAlt ?? "",
    body: body.trim(),
  };
}

// Parsed + newest-first once at module load.
const POSTS: readonly NewsPost[] = Object.entries(FILES)
  .map(([path, raw]) => parsePost(path, raw))
  .sort((a, b) => b.date.localeCompare(a.date));

/** Metadata for every post, newest first. Bodies are stripped — the list page
 *  never needs them. */
export function listNews(): NewsMeta[] {
  return POSTS.map(({ body: _body, ...meta }) => meta);
}

/** A single post by slug, or null when no file matches. */
export function getNewsPost(slug: string): NewsPost | null {
  return POSTS.find((post) => post.slug === slug) ?? null;
}
