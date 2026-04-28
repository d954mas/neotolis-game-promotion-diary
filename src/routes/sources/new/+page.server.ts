import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";

/**
 * /sources/new loader — full-page form for adding a data source (CONTEXT
 * D-09: NOT an inline dialog; same pattern as /games/new and /events/new).
 *
 * The kindMatrix is computed server-side so the page renders all 5 chips
 * with the correct disabled state + phase tooltip (UI-SPEC §"/sources/new"
 * + RESEARCH §5.2 forward-compat — "show disabled with 'Coming in Phase X'
 * copy" is the locked UX). Disabled chips MUST carry `aria-disabled="true"`
 * and `tabindex="-1"` per UI-SPEC FLAG.
 *
 * Anonymous users redirect to /login. The PROTECTED_PATHS array in the
 * layout server load already covers /sources by adding the prefix in
 * Plan 02.1-08 — but we also defend in depth here so a stray request
 * without a session never reaches the form.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  return {
    defaultIsOwnedByMe: true,
    defaultAutoImport: true,
    kindMatrix: [
      {
        value: "youtube_channel" as const,
        labelKey: "source_kind_label_youtube_channel" as const,
        phaseKey: null,
        disabled: false,
      },
      {
        value: "reddit_account" as const,
        labelKey: "source_kind_label_reddit_account" as const,
        phaseKey: "source_kind_phase_reddit_account" as const,
        disabled: true,
      },
      {
        value: "twitter_account" as const,
        labelKey: "source_kind_label_twitter_account" as const,
        phaseKey: "source_kind_phase_twitter_account" as const,
        disabled: true,
      },
      {
        value: "telegram_channel" as const,
        labelKey: "source_kind_label_telegram_channel" as const,
        phaseKey: "source_kind_phase_telegram_channel" as const,
        disabled: true,
      },
      {
        value: "discord_server" as const,
        labelKey: "source_kind_label_discord_server" as const,
        phaseKey: "source_kind_phase_discord_server" as const,
        disabled: true,
      },
    ],
  };
};
