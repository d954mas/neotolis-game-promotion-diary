// Telegram HTTP wrapper — public t.me/s listing + t.me/<ch>/<id>?embed=1 embed.
//
// Responsibilities:
//   - Add a normal browser User-Agent to every outgoing fetch (RESEARCH: a
//     plain Mozilla/5.0 worked live; the default Node UA can get fenced).
//   - Acquire a slot from the global pacer (pacer.ts) before firing the
//     request — the t.me politeness ceiling is enforced once, globally,
//     across the worker + sync user paths.
//   - Map response codes to the AdapterError 5-category taxonomy
//     (transient | rate-limited | not-found | permanent | operator-issue).
//   - A 30s AbortController timeout so a hung t.me connection surfaces as a
//     transient error instead of wedging the worker tick.
//
// Deliberately MUCH simpler than reddit/server/http.ts: NO proxy, NO
// per-user credentials, NO OAuth, NO 403-burst audit. The t.me/s embed
// surface is public and tolerant — a conservative slot + escalating
// pause-on-429/403 (recorded via the pacer) is plenty.
//
// IMPORTANT — content-based not_found: a nonexistent channel returns HTTP 200
// (Telegram never 404s a channel; it 302s t.me/s/<missing> → t.me/<missing>
// which lands on a generic page). This wrapper therefore returns the raw HTML
// as-is for any 2xx; the CONTENT-based not_found decision (absence of widget
// markers) is owned by parse.ts (Plan 02), NOT here. Only real 4xx/5xx/network
// errors throw.

import { AdapterError } from "$lib/sources/errors.js";
import { acquireTelegramPacerSlot, recordTelegramAdapterPause } from "./pacer.js";

// Canonical t.me base. Hard-coded for now — Plan 06 decides whether a smoke
// override env var (mirroring REDDIT_BASE_URL_OVERRIDE) is needed.
const TELEGRAM_BASE = "https://t.me";

// A normal browser-ish UA. RESEARCH confirmed a plain Mozilla/5.0 works live
// against t.me/s; the contact line keeps us identifiable to the operator.
const TELEGRAM_USER_AGENT =
  "Mozilla/5.0 (compatible; NeotolisDiary/1.0; +https://github.com/d954mas/neotolis-game-promotion-diary)";

const TELEGRAM_FETCH_TIMEOUT_MS = 30_000;

/** GET the public listing for a channel (the t.me/s preview). `beforeCursor`
 *  pages back through history (?before=<messageId>). Returns the raw HTML —
 *  the caller passes it to parseTelegramListing (Plan 02). */
export async function fetchTelegramListing(
  channel: string,
  beforeCursor?: string | null,
): Promise<string> {
  const path = `/s/${channel}${beforeCursor != null && beforeCursor !== "" ? `?before=${beforeCursor}` : ""}`;
  return fetchTelegramHtml(`${TELEGRAM_BASE}${path}`);
}

/** GET a single post's embed widget. ALWAYS appends ?embed=1 — the bare
 *  t.me/<channel>/<id> page does NOT carry the view count; the ?embed=1
 *  widget does (Pitfall 2). Returns the raw HTML for parseTelegramPost. */
export async function fetchTelegramPost(channel: string, messageId: string): Promise<string> {
  return fetchTelegramHtml(`${TELEGRAM_BASE}/${channel}/${messageId}?embed=1`);
}

/** Shared fetch core: pacer-acquire-first, browser UA, 30s timeout, and the
 *  AdapterError 5-category mapping. Returns res.text() on any 2xx. */
async function fetchTelegramHtml(url: string): Promise<string> {
  // Global pacer — every telegram fetch goes through one DB-side token so the
  // politeness ceiling holds across worker + sync user paths uniformly.
  // Denial (slot taken OR adapter paused after a 403/429) surfaces as
  // rate-limited; the caller decides retry policy from category + retryAfterMs.
  const slot = await acquireTelegramPacerSlot();
  if (!slot.acquired) {
    throw new AdapterError(`Telegram pacer denied -- ${slot.waitMs}ms until next slot`, {
      category: "rate-limited",
      retryAfterMs: slot.waitMs,
      context: {
        httpStatus: 0,
        source: slot.paused ? "adapter-pause" : "global-pacer",
        pauseReason: slot.pauseReason,
        pausedUntil: slot.pausedUntil?.toISOString() ?? null,
      },
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": TELEGRAM_USER_AGENT,
        Accept: "text/html",
      },
      signal: controller.signal,
    });
  } catch (cause) {
    // Network failure or the 30s abort — both transient; the caller re-queues.
    throw new AdapterError(`Telegram fetch network error: ${String(cause)}`, {
      category: "transient",
      cause,
    });
  } finally {
    clearTimeout(timeout);
  }

  const statusCode = res.status;

  // 429/403 → rate-limited + record an escalating adapter pause via the pacer
  // (the same DB row the slot is read from), so subsequent fetches are denied
  // for the backoff window instead of hammering a fenced endpoint.
  if (statusCode === 429) {
    await recordTelegramAdapterPause("http_429");
    throw new AdapterError("Telegram 429 — rate limited", {
      category: "rate-limited",
      context: { httpStatus: 429 },
    });
  }
  if (statusCode === 403) {
    await recordTelegramAdapterPause("http_403");
    throw new AdapterError("Telegram 403 — rate limited / fenced", {
      category: "rate-limited",
      context: { httpStatus: 403 },
    });
  }
  if (statusCode >= 500) {
    throw new AdapterError(`Telegram ${statusCode}`, {
      category: "transient",
      context: { httpStatus: statusCode },
    });
  }
  // A nonexistent channel still returns 200 — do NOT treat any 2xx as not_found
  // here; parse.ts decides not_found by content. Only non-2xx (other than the
  // handled 403/429/5xx) is an unexpected permanent failure.
  if (statusCode < 200 || statusCode >= 300) {
    throw new AdapterError(`Telegram unexpected ${statusCode}`, {
      category: "permanent",
      context: { httpStatus: statusCode },
    });
  }

  return res.text();
}
