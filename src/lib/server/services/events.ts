// events service — EVENTS-01 / EVENTS-02 / EVENTS-03 backend.
//
// Pattern 1 (tenant scope): EVERY function takes `userId: string` first;
// EVERY Drizzle query .where()-clauses on `eq(events.userId, userId)`. The
// custom ESLint rule `tenant-scope/no-unfiltered-tenant-query` (Plan 02-02)
// fires on any query that omits this filter — disable comments NOT allowed.
//
// kind is the eventKindEnum from schema/events.ts (closed picklist per D-28
// — invalid values reject at INSERT time, not "we'll fix it Tuesday"). The
// constant `VALID_EVENT_KINDS` mirrors the enum so we can validate at the
// service boundary and surface a clean AppError(422) instead of letting the
// PG-level "invalid input value for enum" error bubble out.
//
// Audit (D-32, EVENTS-03): event.created on INSERT, event.edited on UPDATE,
// event.deleted on softDeleteEvent. Metadata shape:
//   { kind, event_id, game_id, occurred_at } for created
//   { kind, event_id, fields }               for edited (fields = changed keys)
//   { event_id, kind }                       for deleted
//
// listTimelineForGame (EVENTS-02): merges events + tracked_youtube_videos
// for the game in a single chronologically-sorted array. Returned rows are
// discriminated by `kind: 'event' | 'youtube_video'` so the UI (Phase 4) can
// render different cells. Phase 4 ships the chart layer; Phase 2 only ships
// this data endpoint.

import { and, eq, isNull, asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { trackedYoutubeVideos } from "../db/schema/tracked-youtube-videos.js";
import { writeAudit } from "../audit.js";
import { getGameById } from "./games.js";
import { AppError, NotFoundError } from "./errors.js";

export type EventRow = typeof events.$inferSelect;

export const VALID_EVENT_KINDS = [
  "conference",
  "talk",
  "twitter_post",
  "telegram_post",
  "discord_drop",
  "press",
  "other",
] as const;
export type EventKind = (typeof VALID_EVENT_KINDS)[number];

export interface CreateEventInput {
  gameId: string;
  kind: EventKind;
  occurredAt: Date | string;
  title: string;
  url?: string | null;
  notes?: string | null;
}

export interface UpdateEventInput {
  kind?: EventKind;
  occurredAt?: Date | string;
  title?: string;
  url?: string | null;
  notes?: string | null;
}

/** Discriminated timeline row — events and tracked items, chronologically merged. */
export type TimelineRow =
  | {
      kind: "event";
      id: string;
      eventKind: EventKind;
      title: string;
      url: string | null;
      notes: string | null;
      occurredAt: Date;
    }
  | {
      kind: "youtube_video";
      id: string;
      title: string | null;
      url: string;
      videoId: string;
      isOwn: boolean;
      occurredAt: Date;
    };

const TITLE_MIN = 1;
const TITLE_MAX = 500;

function validateKind(kind: string): asserts kind is EventKind {
  if (!(VALID_EVENT_KINDS as readonly string[]).includes(kind)) {
    throw new AppError(
      `kind must be one of: ${VALID_EVENT_KINDS.join(", ")}`,
      "validation_failed",
      422,
    );
  }
}

function validateTitle(title: string): void {
  const trimmed = title.trim();
  if (trimmed.length < TITLE_MIN || trimmed.length > TITLE_MAX) {
    throw new AppError(
      `title must be between ${TITLE_MIN} and ${TITLE_MAX} characters`,
      "validation_failed",
      422,
    );
  }
}

function coerceOccurredAt(value: Date | string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new AppError("occurredAt must be a valid date", "validation_failed", 422);
  }
  return d;
}

/**
 * Create an event scoped to userId. Validates kind / title / occurredAt
 * BEFORE any INSERT — never produces an orphan row on validation fail.
 * Pre-flight `getGameById` for cross-tenant defense.
 *
 * Audit: writes `event.created` with metadata
 *   { kind, event_id, game_id, occurred_at }
 */
export async function createEvent(
  userId: string,
  input: CreateEventInput,
  ipAddress: string,
): Promise<EventRow> {
  validateKind(input.kind);
  validateTitle(input.title);
  const occurredAt = coerceOccurredAt(input.occurredAt);
  await getGameById(userId, input.gameId);

  const [row] = await db
    .insert(events)
    .values({
      userId,
      gameId: input.gameId,
      kind: input.kind,
      occurredAt,
      title: input.title.trim(),
      url: input.url ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  if (!row) throw new Error("createEvent: INSERT returned no row");

  await writeAudit({
    userId,
    action: "event.created",
    ipAddress,
    metadata: {
      kind: row.kind,
      event_id: row.id,
      game_id: row.gameId,
      occurred_at: occurredAt.toISOString(),
    },
  });

  return row;
}

/**
 * List active events (soft-deleted excluded) for a game, oldest first.
 * Asserts game ownership for cross-tenant defense.
 */
export async function listEventsForGame(
  userId: string,
  gameId: string,
): Promise<EventRow[]> {
  await getGameById(userId, gameId);
  return db
    .select()
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.gameId, gameId),
        isNull(events.deletedAt),
      ),
    )
    .orderBy(asc(events.occurredAt));
}

/**
 * Read one event scoped to userId. NotFoundError on miss or cross-tenant.
 * Soft-deleted rows are treated as missing (Plan 02-08 expects 404 on read
 * of a deleted event).
 */
export async function getEventById(userId: string, eventId: string): Promise<EventRow> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.id, eventId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.deletedAt !== null) throw new NotFoundError();
  return row;
}

/**
 * Update an event in-place. Validates kind / title / occurredAt only when
 * supplied. Bumps `updatedAt`. NotFoundError on miss or cross-tenant.
 *
 * Audit: writes `event.edited` with metadata
 *   { kind, event_id, fields: <list of keys actually patched> }
 */
export async function updateEvent(
  userId: string,
  eventId: string,
  input: UpdateEventInput,
  ipAddress: string,
): Promise<EventRow> {
  if (input.kind !== undefined) validateKind(input.kind);
  if (input.title !== undefined) validateTitle(input.title);

  const patch: Partial<typeof events.$inferInsert> = { updatedAt: new Date() };
  const fields: string[] = [];
  if (input.kind !== undefined) {
    patch.kind = input.kind;
    fields.push("kind");
  }
  if (input.occurredAt !== undefined) {
    patch.occurredAt = coerceOccurredAt(input.occurredAt);
    fields.push("occurredAt");
  }
  if (input.title !== undefined) {
    patch.title = input.title.trim();
    fields.push("title");
  }
  if (input.url !== undefined) {
    patch.url = input.url;
    fields.push("url");
  }
  if (input.notes !== undefined) {
    patch.notes = input.notes;
    fields.push("notes");
  }

  const [row] = await db
    .update(events)
    .set(patch)
    .where(and(eq(events.userId, userId), eq(events.id, eventId), isNull(events.deletedAt)))
    .returning();
  if (!row) throw new NotFoundError();

  await writeAudit({
    userId,
    action: "event.edited",
    ipAddress,
    metadata: { kind: row.kind, event_id: row.id, fields },
  });

  return row;
}

/**
 * Soft-delete an event. Phase 3 purge worker hard-deletes after
 * RETENTION_DAYS (D-22). NotFoundError on miss / cross-tenant.
 *
 * Audit: writes `event.deleted` with metadata { event_id, kind }.
 */
export async function softDeleteEvent(
  userId: string,
  eventId: string,
  ipAddress: string,
): Promise<void> {
  const result = await db
    .update(events)
    .set({ deletedAt: new Date() })
    .where(and(eq(events.userId, userId), eq(events.id, eventId), isNull(events.deletedAt)))
    .returning({ id: events.id, kind: events.kind });
  const row = result[0];
  if (!row) throw new NotFoundError();

  await writeAudit({
    userId,
    action: "event.deleted",
    ipAddress,
    metadata: { event_id: row.id, kind: row.kind },
  });
}

/**
 * EVENTS-02 timeline endpoint: events + tracked_youtube_videos for a game,
 * merged into one chronologically-sorted array (oldest first). The Phase 4
 * chart layer renders the merged feed; Phase 2 only ships the data.
 *
 * Soft-deleted rows excluded from both sources. Asserts game ownership.
 */
export async function listTimelineForGame(
  userId: string,
  gameId: string,
): Promise<TimelineRow[]> {
  await getGameById(userId, gameId);

  const eventRows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.gameId, gameId),
        isNull(events.deletedAt),
      ),
    );

  const videoRows = await db
    .select()
    .from(trackedYoutubeVideos)
    .where(
      and(
        eq(trackedYoutubeVideos.userId, userId),
        eq(trackedYoutubeVideos.gameId, gameId),
        isNull(trackedYoutubeVideos.deletedAt),
      ),
    );

  const merged: TimelineRow[] = [
    ...eventRows.map<TimelineRow>((r) => ({
      kind: "event",
      id: r.id,
      eventKind: r.kind as EventKind,
      title: r.title,
      url: r.url,
      notes: r.notes,
      occurredAt: r.occurredAt,
    })),
    ...videoRows.map<TimelineRow>((r) => ({
      kind: "youtube_video",
      id: r.id,
      title: r.title,
      url: r.url,
      videoId: r.videoId,
      isOwn: r.isOwn,
      // tracked_youtube_videos has no `occurred_at` column; the user-meaningful
      // "when" for an own/blogger video is when it was added to the diary.
      occurredAt: r.addedAt,
    })),
  ];

  merged.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  return merged;
}
