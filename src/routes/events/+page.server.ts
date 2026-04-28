import type { PageServerLoad } from "./$types";
import { listGames } from "$lib/server/services/games.js";
import { listEventsForGame } from "$lib/server/services/events.js";
import { toGameDto, toEventDto } from "$lib/server/dto.js";

/**
 * /events loader — global event timeline (Plan 02-10).
 *
 * Plan 02-08 ships per-game listEventsForGame but no global
 * `listEventsForUser`. The plan decision (UI-SPEC §"/events") is to
 * use a per-game-fetch + JS merge in Phase 2; Phase 6 polish adds the
 * single endpoint. The math is acceptable for indie-scale lists (most
 * users will have <20 games × <50 events).
 *
 * Direct service calls (NOT fetch('/api/...')): the API and the page
 * render in the same Node process, so an HTTP roundtrip back to Hono
 * would deadlock SvelteKit's internal_fetch (Hono routes don't live in
 * SvelteKit's route tree — see post-execution P0 fix in SUMMARY).
 *
 * The per-game calls run in parallel via Promise.all. The active games
 * list (no soft-deleted) drives the games-picker dropdown in the new-event
 * form.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) return { events: [], games: [] };
  const userId = locals.user.id;

  const gameRows = await listGames(userId);
  const games = gameRows.map(toGameDto);

  if (games.length === 0) {
    return { events: [], games };
  }

  type EnrichedEvent = ReturnType<typeof toEventDto> & {
    gameId: string;
    gameTitle: string;
    occurredAt: string;
  };

  const eventResults = await Promise.all(
    games.map(async (g): Promise<EnrichedEvent[]> => {
      const rows = await listEventsForGame(userId, g.id).catch(() => []);
      return rows.map((r) => {
        const dto = toEventDto(r);
        return {
          ...dto,
          gameId: g.id,
          gameTitle: g.title,
          // Coerce Date → ISO string so the +page.svelte's localeCompare sort
          // and slice(0, 7) month grouping work without further conversion.
          occurredAt:
            dto.occurredAt instanceof Date
              ? dto.occurredAt.toISOString()
              : String(dto.occurredAt ?? ""),
        };
      });
    }),
  );

  const merged = eventResults.flat();
  merged.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return { events: merged, games };
};
