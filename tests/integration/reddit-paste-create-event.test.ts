// The Reddit PASTE -> createEvent path (not the preview route).
//
// RESTORED COVERAGE: the pre-Phase-12 tree had reddit-paste-via-api-events.test.ts
// covering paste-through-createEvent; the rebuild replaced it with
// reddit-paste-preview.test.ts, which covers only /api/events/preview-url. The CREATE
// path went untested — and it turned out to be carrying a real regression:
// `author_is_me` was never matched on paste at all. The code comment claimed the match
// lived in `syncStats.fetch`; the rebuilt Reddit adapter has no syncStats, so a dev
// pasting their OWN post filed it as somebody else's until a walk happened to re-cover
// it. Fixed by redditAdapter.resolveCachedAuthorIsMe, guarded here.
//
// createEvent itself issues NO provider request (the preview does, and it writes the
// reddit_posts cache). These tests therefore seed the cache row the preview would have
// written, which is exactly the state the create path reads.
//
// Requirements: PLAT-04 / CHECKLIST §3 (per-post author_is_me).
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";

const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { redditPosts } = await import("../../src/lib/server/db/schema/index.js");
const { createEvent } = await import("../../src/lib/server/services/events-mutation.js");

const uniq = (): string => Math.random().toString(36).slice(2, 8);
const postUrl = (shortId: string): string =>
  `https://www.reddit.com/r/gamedev/comments/${shortId}/pasted_devlog/`;

/** The reddit_posts row the paste PREVIEW writes before the user hits Save. */
async function seedCachedPost(shortId: string, author: string): Promise<void> {
  await db.insert(redditPosts).values({
    postId: `t3_${shortId}`,
    subredditSlug: "gamedev",
    permalink: postUrl(shortId),
    author,
    authorFullname: `t2_${author}`,
    title: "Pasted devlog",
    publishedAt: new Date("2026-06-10T09:00:00Z"),
    lastPolledAt: new Date("2026-06-10T09:30:00Z"),
    lastPollStatus: "ok",
  });
}

/** Register a reddit_account the user declares as THEIR OWN identity. */
async function seedOwnedAccount(userId: string, handle: string): Promise<void> {
  await db.insert(dataSources).values({
    userId,
    kind: "reddit_account",
    handleUrl: `https://www.reddit.com/user/${handle}`,
    channelId: handle,
    isOwnedByMe: true,
    autoImport: false,
    metadata: { handle },
  });
}

async function paste(
  userId: string,
  shortId: string,
  title = "Pasted devlog",
  authorIsMe?: boolean,
): Promise<string> {
  const event = await createEvent(
    userId,
    {
      gameIds: [],
      kind: "reddit_post",
      title,
      occurredAt: new Date("2026-06-10T09:00:00Z"),
      url: postUrl(shortId),
      ...(authorIsMe === undefined ? {} : { authorIsMe }),
    },
    "127.0.0.1",
  );
  return event.id;
}

async function readEvent(userId: string, eventId: string) {
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.id, eventId)));
  return row;
}

describe("reddit paste -> createEvent", () => {
  it("[regression] a post by an OWNED reddit_account is filed as author_is_me", async () => {
    const u = await seedUserDirectly({ email: `rdt-paste-mine-${uniq()}@t.io` });
    const handle = `Mine${uniq()}`;
    const shortId = `pm${uniq()}`;
    await seedOwnedAccount(u.id, handle);
    await seedCachedPost(shortId, handle);

    const id = await paste(u.id, shortId);

    expect((await readEvent(u.id, id))!.authorIsMe, "my own post must read as mine").toBe(true);
  });

  it("[regression] the author match is CASE-INSENSITIVE (Reddit preserves display case)", async () => {
    const u = await seedUserDirectly({ email: `rdt-paste-case-${uniq()}@t.io` });
    const handle = `MixedCase${uniq()}`;
    const shortId = `pc${uniq()}`;
    // Source registered lowercase (canonicalizeOnCreate), post author in display case.
    await seedOwnedAccount(u.id, handle.toLowerCase());
    await seedCachedPost(shortId, handle);

    const id = await paste(u.id, shortId);

    expect((await readEvent(u.id, id))!.authorIsMe).toBe(true);
  });

  it("a post by SOMEONE ELSE is not mine, even with an owned account registered", async () => {
    const u = await seedUserDirectly({ email: `rdt-paste-theirs-${uniq()}@t.io` });
    const shortId = `pt${uniq()}`;
    await seedOwnedAccount(u.id, `Mine${uniq()}`);
    await seedCachedPost(shortId, `Stranger${uniq()}`);

    const id = await paste(u.id, shortId, "Someone else's post");

    expect(
      (await readEvent(u.id, id))!.authorIsMe,
      "a stranger's post must never be tagged mine",
    ).toBe(false);
  });

  it("another tenant's owned account must not make MY paste read as mine", async () => {
    const mine = await seedUserDirectly({ email: `rdt-paste-a-${uniq()}@t.io` });
    const other = await seedUserDirectly({ email: `rdt-paste-b-${uniq()}@t.io` });
    const handle = `Shared${uniq()}`;
    const shortId = `px${uniq()}`;
    // The OTHER tenant claims the handle; the pasting tenant does not.
    await seedOwnedAccount(other.id, handle);
    await seedCachedPost(shortId, handle);

    const id = await paste(mine.id, shortId);

    expect(
      (await readEvent(mine.id, id))!.authorIsMe,
      "ownership is per-tenant — never cross-tenant",
    ).toBe(false);
  });

  it("an explicit authorIsMe from the caller wins over the cache match", async () => {
    const u = await seedUserDirectly({ email: `rdt-paste-explicit-${uniq()}@t.io` });
    const handle = `Mine${uniq()}`;
    const shortId = `pe${uniq()}`;
    await seedOwnedAccount(u.id, handle);
    await seedCachedPost(shortId, handle);

    const id = await paste(u.id, shortId, "Not mine after all", false);

    expect(
      (await readEvent(u.id, id))!.authorIsMe,
      "the user's explicit choice is never overridden",
    ).toBe(false);
  });

  it("a paste with no cached post (no preview run) saves an honest not-mine card", async () => {
    const u = await seedUserDirectly({ email: `rdt-paste-nocache-${uniq()}@t.io` });
    const shortId = `pn${uniq()}`;
    await seedOwnedAccount(u.id, `Mine${uniq()}`);

    const id = await paste(u.id, shortId, "Typed by hand");

    const row = await readEvent(u.id, id);
    expect(row, "the diary entry always saves — manual entry never dead-ends").toBeDefined();
    expect(row!.authorIsMe).toBe(false);
    expect(row!.externalId, "the t3 id is URL-derivable, so it is stored even cache-less").toBe(
      `t3_${shortId}`,
    );
  });

  it("pasting the same post twice yields TWO events against ONE cached post row", async () => {
    const u = await seedUserDirectly({ email: `rdt-paste-idem-${uniq()}@t.io` });
    const shortId = `pi${uniq()}`;
    await seedCachedPost(shortId, `Auth${uniq()}`);

    const first = await paste(u.id, shortId);
    const second = await paste(u.id, shortId, "Pasted devlog again");

    expect(second, "a re-paste is a distinct diary entry").not.toBe(first);
    const cached = await db
      .select()
      .from(redditPosts)
      .where(eq(redditPosts.postId, `t3_${shortId}`));
    expect(cached, "the public-data post cache is keyed by post id, never duplicated").toHaveLength(
      1,
    );
    for (const id of [first, second]) {
      expect((await readEvent(u.id, id))!.externalId, "both events key the same post").toBe(
        `t3_${shortId}`,
      );
    }
  });
});
