import type { Actions, PageServerLoad } from "./$types";
import { fail, redirect } from "@sveltejs/kit";
import { allAdapters, getAdapter, hasAdapter } from "$lib/sources/registry.js";
import { createSource } from "$lib/server/services/data-sources.js";
import { AppError } from "$lib/server/services/errors.js";

/**
 * /sources/new loader — full-page form for adding a data source.
 *
 * The kindMatrix is computed server-side so the page renders all 6 chips
 * with the correct disabled state + status tooltip. Disabled chips MUST
 * carry `aria-disabled="true"` and `tabindex="-1"`.
 *
 * Reddit kinds (`reddit_account` + `reddit_subreddit`) are enabled iff
 * the Reddit adapter reports `observability.auth.isOperatorConfigured` (env.REDDIT_USER_AGENT non-empty). When
 * the operator has not configured Reddit (e.g., self-host before env
 * setup), Reddit chips remain disabled with a "not configured" tooltip
 * (D-RDT-AUTH-EMPTY); the form's auto-detect path still fires server-side
 * but returns a typed error.
 *
 * Anonymous users redirect to /login. The PROTECTED_PATHS array in the
 * layout server load already covers /sources but we defend in depth here
 * so a stray request without a session never reaches the form.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  // Read configured-ness through the adapter contract instead of a
  // direct env probe — same fact, no per-source import leak into the
  // SvelteKit loader.
  const redditOperatorConfigured = hasAdapter("reddit_account")
    ? getAdapter("reddit_account").observability.auth.isOperatorConfigured
    : false;
  return {
    defaultIsOwnedByMe: true,
    defaultAutoImport: true,
    redditOperatorConfigured,
    kindMatrix: [
      {
        value: "youtube_channel" as const,
        labelKey: "source_kind_label_youtube_channel" as const,
        statusKey: null,
        disabled: false,
      },
      {
        // Single "Reddit" chip — the backend resolves subreddit vs account
        // from the URL shape via redditAdapter.parseSourceUrl. The user
        // doesn't pre-pick; pasting reddit.com/r/X creates a subreddit
        // source, reddit.com/user/X creates an account source. The /sources
        // list still paints them distinctly (🏛 vs 🧑) via SourceRow.
        value: "reddit" as const,
        labelKey: "common_kind_reddit" as const,
        statusKey: redditOperatorConfigured ? null : "source_kind_status_reddit_account",
        disabled: !redditOperatorConfigured,
      },
      {
        value: "twitter_account" as const,
        labelKey: "source_kind_label_twitter_account" as const,
        statusKey: "source_kind_status_twitter_account" as const,
        disabled: true,
      },
      {
        value: "telegram_channel" as const,
        labelKey: "source_kind_label_telegram_channel" as const,
        statusKey: "source_kind_status_telegram_channel" as const,
        disabled: true,
      },
      {
        value: "discord_server" as const,
        labelKey: "source_kind_label_discord_server" as const,
        statusKey: "source_kind_status_discord_server" as const,
        disabled: true,
      },
    ],
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
        kindRaw !== "discord_server"
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
