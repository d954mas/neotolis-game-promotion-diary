import type { Actions, PageServerLoad } from "./$types";
import { fail, redirect } from "@sveltejs/kit";
import { allAdapters, getAdapter, hasAdapter } from "$lib/sources/registry.js";
import { buildKindMatrix } from "$lib/sources/kind-matrix.js";
import { createSource } from "$lib/server/services/data-sources.js";
import { AppError } from "$lib/server/services/errors.js";
import { env } from "$lib/server/config/env.js";

/**
 * /sources/new loader — full-page, non-JS fallback for the AddSourceModal.
 *
 * The kindMatrix is computed server-side via buildKindMatrix — the SAME call
 * the /sources loader makes (F1), so the modal and this fallback can never
 * drift in which kinds they offer. Every entry's disabled state derives from
 * FUNCTIONAL_KINDS + per-adapter isOperatorConfigured: the synthetic "reddit"
 * chip, the not-built (Twitter / Discord) entries, and the not-configured
 * (Reddit / Instagram without env) greying all come out of the derivation —
 * no hand-maintained literal here. The page is URL-first (the pasted link
 * decides the kind; chips are an informational legend), reading the
 * not-configured state off each entry's disabledReason.
 *
 * Anonymous users redirect to /login. The PROTECTED_PATHS array in the
 * layout server load already covers /sources but we defend in depth here
 * so a stray request without a session never reaches the form.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  return {
    defaultIsOwnedByMe: true,
    defaultAutoImport: true,
    // BACK-01: per-adapter post-cap ceilings for the BackfillPicker honesty note.
    // IG and Telegram have separate caps; the page passes the kind-appropriate
    // one to the picker.
    socialBackfillMaxPosts: env.SOCIAL_BACKFILL_MAX_POSTS,
    telegramBackfillMaxPosts: env.TELEGRAM_BACKFILL_MAX_POSTS,
    kindMatrix: buildKindMatrix(),
  };
};

/**
 * Form action — server-side auto-detect of source kind from a pasted URL.
 *
 * Iterates `allAdapters[*].parseSourceUrl(input)` in registry order
 * (first non-null wins). When a match is found, the adapter has
 * already resolved (a) the canonical handle URL and (b) the SourceKind
 * (`reddit.com/user/X` → `reddit_account`; `reddit.com/r/X` →
 * `reddit_subreddit`). The form skips the "pick kind" prompt — the URL
 * shape IS the disambiguator.
 *
 * When no adapter matches (e.g., pasting a YouTube URL today —
 * YouTube uses canonicalizeOnCreate, not parseSourceUrl), the user
 * MUST have selected a kind via the chip picker; we fall through to
 * the user-selected kind path.
 *
 * Reddit specifically: when the adapter reports not-configured we still
 * accept the auto-detect path so the typed error
 * (`reddit_not_configured` 422) flows through to the UI; the user sees
 * the "Reddit not configured" hint AND a structured 422 toast.
 */
export const actions: Actions = {
  default: async ({ request, locals, getClientAddress, url }) => {
    if (!locals.user) {
      throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
    }
    const form = await request.formData();
    const handleUrlRaw = (form.get("handleUrl") as string | null) ?? "";
    const handleUrl = handleUrlRaw.trim();
    const kindRaw = (form.get("kind") as string | null) ?? "";
    const displayNameRaw = form.get("displayName");
    const displayName =
      typeof displayNameRaw === "string" && displayNameRaw.trim().length > 0
        ? displayNameRaw.trim()
        : null;
    const isOwnedByMe = form.get("isOwnedByMe") === "true";
    const autoImport = form.get("autoImport") === "true";
    const description = (form.get("description") as string | null)?.trim() ?? "";
    const backfillWindowRaw = (form.get("backfillWindow") as string | null) ?? undefined;
    const backfillWindow =
      backfillWindowRaw &&
      ["1d", "7d", "30d", "90d", "1y", "everything"].includes(backfillWindowRaw)
        ? (backfillWindowRaw as "1d" | "7d" | "30d" | "90d" | "1y" | "everything")
        : undefined;

    if (handleUrl.length === 0) {
      return fail(422, { error: "validation_failed", message: "handleUrl required" });
    }

    // Auto-detect via adapter.parseSourceUrl iterator. First non-null
    // wins; Reddit auto-detects /user/X vs /r/X without the user
    // picking a kind. YouTube doesn't implement parseSourceUrl (its
    // single SourceKind=youtube_channel is canonicalized inside
    // createSource via canonicalizeOnCreate), so YouTube URLs fall
    // through and the user MUST have selected `youtube_channel` via
    // the chip picker.
    let resolvedKind:
      | "youtube_channel"
      | "reddit_account"
      | "reddit_subreddit"
      | "twitter_account"
      | "telegram_channel"
      | "discord_server"
      | "instagram_account"
      | "tiktok_account"
      | null = null;
    let resolvedHandleUrl = handleUrl;
    let resolvedDisplayName = displayName;

    for (const adapter of allAdapters) {
      if (typeof adapter.parseSourceUrl !== "function") continue;
      const parsed = adapter.parseSourceUrl(handleUrl);
      if (parsed === null) continue;
      resolvedKind = parsed.kind;
      resolvedHandleUrl = parsed.externalUrl;
      resolvedDisplayName ??= parsed.handle;
      break;
    }

    if (resolvedKind === null) {
      // No adapter auto-detected. Fall back to the user-picked kind from
      // the chip selector — preserves the YouTube flow + future
      // platforms that don't implement parseSourceUrl. The synthetic
      // "reddit" picker entry needs a second pass through the Reddit adapter's parseSourceUrl
      // — if the URL was already auto-detectable the iterator above would
      // have caught it, so reaching this branch with kindRaw="reddit"
      // means the input is not a recognizable Reddit URL.
      if (kindRaw === "reddit") {
        const parsed = hasAdapter("reddit_account")
          ? (getAdapter("reddit_account").parseSourceUrl?.(handleUrl) ?? null)
          : null;
        if (parsed === null) {
          return fail(422, {
            error: "invalid_reddit_url",
            message: "URL does not look like a Reddit subreddit or user profile",
          });
        }
        resolvedKind = parsed.kind;
        resolvedHandleUrl = parsed.externalUrl;
        resolvedDisplayName ??= parsed.handle;
      } else if (
        kindRaw !== "youtube_channel" &&
        kindRaw !== "reddit_account" &&
        kindRaw !== "reddit_subreddit" &&
        kindRaw !== "twitter_account" &&
        kindRaw !== "telegram_channel" &&
        kindRaw !== "discord_server" &&
        kindRaw !== "instagram_account" &&
        kindRaw !== "tiktok_account"
      ) {
        return fail(422, { error: "validation_failed", message: "kind required" });
      } else {
        resolvedKind = kindRaw;
      }
    }

    // SvelteKit's getClientAddress() returns the trusted-proxy-resolved
    // peer IP (the SvelteKit adapter wires proxy-trust at the request
    // boundary, mirroring the Hono middleware). For audit metadata this
    // is the load-bearing field.
    const ipAddress = getClientAddress();

    // Reddit source metadata: the adapter's onSourceCreated /
    // backfillSource dispatch on `metadata.username` (reddit_account) or
    // `metadata.subreddit` (reddit_subreddit). Without these keys the
    // first backfill enqueue silently no-ops (see adapter.ts L106-110).
    // We populate them ONLY when the URL was auto-detected by
    // parseSourceUrl (so the handle is canonical); manual-kind picks for
    // Reddit fall back to a parse on the user-typed handleUrl.
    const metadata: Record<string, unknown> = {};
    if (description) metadata.description = description;
    if (resolvedKind === "reddit_account" || resolvedKind === "reddit_subreddit") {
      // resolvedDisplayName came from parsed.handle (set just above when
      // parseSourceUrl matched). When the user picked the Reddit chip
      // and typed a non-URL, displayName is null — backfillSource
      // logs WARN and skips, which is the documented contract.
      if (resolvedKind === "reddit_account" && resolvedDisplayName) {
        metadata.username = resolvedDisplayName;
      } else if (resolvedKind === "reddit_subreddit" && resolvedDisplayName) {
        metadata.subreddit = resolvedDisplayName;
      }
    }

    try {
      await createSource(
        locals.user.id,
        {
          kind: resolvedKind,
          handleUrl: resolvedHandleUrl,
          displayName: resolvedDisplayName,
          isOwnedByMe,
          autoImport,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          backfillWindow,
        },
        ipAddress,
        request.headers.get("user-agent") ?? undefined,
      );
    } catch (err) {
      if (err instanceof AppError) {
        return fail(err.status as 422 | 409 | 503, {
          error: err.code,
          message: err.message,
          metadata: err.metadata ?? {},
        });
      }
      return fail(500, { error: "server_error", message: "Failed to create source" });
    }

    throw redirect(303, "/sources");
  },
};
