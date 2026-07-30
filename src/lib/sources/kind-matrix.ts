// buildKindMatrix — the SINGLE source of truth for the Add-Source UI's
// per-kind enabled/disabled state. Both /sources loaders
// (src/routes/sources/+page.server.ts and src/routes/sources/new/+page.server.ts)
// call this so the modal and the non-JS fallback can NEVER drift in which
// kinds are offered (F1 — eliminated the hand-maintained parallel literal
// arrays the two loaders used to each carry).
//
// EVERY field is DERIVED from cross-source truth — there is no hardcoded
// telegram/twitter/discord disabled literal:
//   - `disabled` / `disabledReason` come from FUNCTIONAL_KINDS + each adapter's
//     observability.auth.isOperatorConfigured (data-sources.ts owns the former;
//     the adapter owns the latter). A kind that flips functional (added to
//     FUNCTIONAL_KINDS + given an adapter) lights up BOTH /sources surfaces
//     automatically — the SOURCE-REFERENCE §12 "config-driven, no silent
//     two-file drift" philosophy applied to the Add-Source matrix.
//   - `statusKey` is the paraglide key for the disabled-chip rationale; null
//     when the chip is enabled.
//
// SERVER-ONLY: imports data-sources.ts (DB client) + the registry (adapter
// instances). Both callers are +page.server.ts loaders, so the matrix is built
// on the server and shipped to the client as plain data.

import type { SourceKind } from "./adapter.js";
import { getAdapter, hasAdapter } from "./registry.js";
import { FUNCTIONAL_KINDS } from "$lib/server/services/data-sources.js";

// UI-level kinds the Add-Source chip legend exposes. "reddit" is SYNTHETIC —
// a single chip the server resolves to reddit_account vs reddit_subreddit by
// URL shape (the DB column never stores "reddit"). Mirrors the SourceKind
// union in the two Add-Source surfaces + infer-source-kind.ts.
export type AddSourceUiKind =
  | "youtube_channel"
  | "reddit"
  | "twitter_account"
  | "telegram_channel"
  | "discord_server"
  | "instagram_account"
  | "tiktok_account";

export type KindLabelKey =
  | "source_kind_label_youtube_channel"
  | "source_kind_label_twitter_account"
  | "source_kind_label_telegram_channel"
  | "source_kind_label_discord_server"
  | "source_kind_label_instagram_account"
  | "source_kind_label_tiktok_account"
  | "common_kind_reddit";

export type KindStatusKey =
  | "source_kind_status_reddit_account"
  | "source_kind_status_twitter_account"
  | "source_kind_status_telegram_channel"
  | "source_kind_status_discord_server"
  | "source_kind_status_instagram_account"
  | "source_kind_status_tiktok_account";

// disabledReason distinguishes "adapter built, operator env unset" (Reddit /
// Instagram unconfigured → "not-configured") from "not built yet" (Twitter /
// Discord → "not-built") so the disabled-chip tooltip is accurate (issue #64).
// null for enabled chips.
export type DisabledReason = "not-configured" | "not-built";

export type KindMatrixEntry = {
  value: AddSourceUiKind;
  labelKey: KindLabelKey;
  statusKey: KindStatusKey | null;
  disabled: boolean;
  disabledReason: DisabledReason | null;
  /** The operator env var(s) that turn this kind ON, named in the not-configured
   *  TOOLTIP. The chip itself only shows the short "not configured" status — a full
   *  env-var sentence inside a compact legend chip blew the legend up (12-06 UAT),
   *  doubly so for Reddit's u/ + r/ plate pair — but a self-host operator still has
   *  to learn WHICH variable to set, and the tooltip is the place that costs no
   *  layout. null for kinds with nothing to configure (always-on) or not built yet
   *  (those render the "schema ready, adapter isn't" tooltip instead). */
  envVar: string | null;
};

// Static per-UI-kind facts that are NOT derivable: the human label key, the
// disabled-status paraglide key, and the representative DB SourceKind used to
// probe FUNCTIONAL_KINDS + the adapter. The synthetic "reddit" UI kind probes
// reddit_account (reddit_account + reddit_subreddit share one adapter +
// functional state). Render ORDER is array order (a deliberate UX choice).
const UI_KINDS: ReadonlyArray<{
  value: AddSourceUiKind;
  labelKey: KindLabelKey;
  // null for kinds that are always enabled (no disabled-state rationale to show);
  // a real key only for kinds that can render disabled (not-built / not-configured).
  statusKey: KindStatusKey | null;
  probeKind: SourceKind;
  /** Operator env var(s) named in the not-configured tooltip; null when there is
   *  nothing to configure. Static per-kind fact — exactly what this table is for. */
  envVar: string | null;
}> = [
  {
    value: "youtube_channel",
    labelKey: "source_kind_label_youtube_channel",
    // YouTube is always functional + no operator-config gate, so it never renders
    // disabled → no status string of its own (null, not a borrowed placeholder).
    statusKey: null,
    probeKind: "youtube_channel",
    envVar: null,
  },
  {
    value: "reddit",
    labelKey: "common_kind_reddit",
    statusKey: "source_kind_status_reddit_account",
    probeKind: "reddit_account",
    envVar: "REDDIT_IMPORT_ENABLED=true (plus REDDIT_PROVIDER)",
  },
  {
    value: "instagram_account",
    labelKey: "source_kind_label_instagram_account",
    statusKey: "source_kind_status_instagram_account",
    probeKind: "instagram_account",
    envVar: "INSTAGRAM_PROVIDER",
  },
  {
    value: "tiktok_account",
    labelKey: "source_kind_label_tiktok_account",
    statusKey: "source_kind_status_tiktok_account",
    probeKind: "tiktok_account",
    envVar: "TIKTOK_PROVIDER",
  },
  {
    value: "twitter_account",
    labelKey: "source_kind_label_twitter_account",
    statusKey: "source_kind_status_twitter_account",
    probeKind: "twitter_account",
    envVar: "TWITTER_PROVIDER",
  },
  {
    value: "telegram_channel",
    labelKey: "source_kind_label_telegram_channel",
    statusKey: "source_kind_status_telegram_channel",
    probeKind: "telegram_channel",
    envVar: null,
  },
  {
    value: "discord_server",
    labelKey: "source_kind_label_discord_server",
    statusKey: "source_kind_status_discord_server",
    probeKind: "discord_server",
    envVar: null,
  },
];

/**
 * Build the Add-Source kindMatrix, deriving each entry's disabled state from
 * the cross-source truth. One call per loader; the result is plain data.
 *
 * Derivation (one rule, no per-kind literal):
 *   - NOT in FUNCTIONAL_KINDS → disabled "not-built" (Twitter / Discord today).
 *   - functional, adapter reports !isOperatorConfigured → disabled
 *     "not-configured" (Reddit with isRedditConfigured() false, Instagram
 *     without a provider key).
 *   - functional + configured → enabled (YouTube, Telegram always; Reddit /
 *     Instagram once the operator sets their env).
 *
 * Telegram comes out ENABLED with NO hardcoded literal: it is in
 * FUNCTIONAL_KINDS and its adapter's isOperatorConfigured is the constant true
 * (free t.me/s scrape, nothing to configure).
 */
export function buildKindMatrix(): KindMatrixEntry[] {
  return UI_KINDS.map((ui) => {
    const functional = FUNCTIONAL_KINDS.has(ui.probeKind);
    if (!functional) {
      return {
        value: ui.value,
        labelKey: ui.labelKey,
        statusKey: ui.statusKey,
        envVar: ui.envVar,
        disabled: true,
        disabledReason: "not-built",
      };
    }
    // Functional kinds always have a registered adapter; isOperatorConfigured
    // is the canonical "operator has set the env" probe (Telegram = always
    // true; Reddit / Instagram = derived from their env).
    const configured = hasAdapter(ui.probeKind)
      ? getAdapter(ui.probeKind).observability.auth.isOperatorConfigured
      : false;
    if (!configured) {
      return {
        value: ui.value,
        labelKey: ui.labelKey,
        statusKey: ui.statusKey,
        envVar: ui.envVar,
        disabled: true,
        disabledReason: "not-configured",
      };
    }
    return {
      value: ui.value,
      labelKey: ui.labelKey,
      statusKey: null,
      envVar: null,
      disabled: false,
      disabledReason: null,
    };
  });
}
