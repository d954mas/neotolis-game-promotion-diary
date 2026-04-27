import type { PageServerLoad } from "./$types";

/**
 * /events loader — global event timeline (Plan 02-10).
 *
 * Plan 02-08 ships per-game GET /api/games/:gameId/events but no global
 * `GET /api/events?...`. The plan decision (UI-SPEC §"/events") is to
 * use a per-game-fetch + JS merge in Phase 2; Phase 6 polish adds the
 * single endpoint. The math is acceptable for indie-scale lists (most
 * users will have <20 games × <50 events).
 *
 * The per-game fetches run in parallel via Promise.all. The active games
 * list (no soft-deleted) drives the games-picker dropdown in the new-event
 * form.
 */
export const load: PageServerLoad = async ({ fetch, parent }) => {
  const { user } = await parent();
  if (!user) return { events: [], games: [] };

  const gamesRes = await fetch("/api/games");
  if (!gamesRes.ok) return { events: [], games: [] };
  const games = (await gamesRes.json()) as Array<{ id: string; title: string }>;

  if (games.length === 0) {
    return { events: [], games };
  }

  type EnrichedEvent = Record<string, unknown> & {
    occurredAt: string;
    gameId: string;
    gameTitle: string;
  };

  const eventResults = await Promise.all(
    games.map(async (g): Promise<EnrichedEvent[]> => {
      const r = await fetch(`/api/games/${g.id}/events`);
      if (!r.ok) return [];
      const list = (await r.json()) as Array<Record<string, unknown>>;
      return list.map((e) => ({
        ...e,
        gameId: g.id,
        gameTitle: g.title,
        occurredAt: String(e.occurredAt ?? ""),
      }));
    }),
  );

  const merged = eventResults.flat();
  // Sort newest first.
  merged.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return { events: merged, games };
};
