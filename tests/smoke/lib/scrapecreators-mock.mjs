// Hermetic ScrapeCreators Reddit mock for the provider-ON smoke gate.
//
// Mirrors youtube-mock.mjs: a tiny long-lived Node http stub that stands in for the
// real ScrapeCreators API so the smoke gate can boot the production image with the
// Reddit provider ON (REDDIT_IMPORT_ENABLED=true) and exercise the full seam —
// bootstrap, worker registration, the reserve-before-HTTP budget path, the author /
// subreddit walk, and the reddit_posts + snapshot writes — WITHOUT a live API key or
// any network egress. No real ScrapeCreators traffic ever leaves CI.
//
// Surface (the only two endpoints the reddit provider issues — provider/
// scrapecreators-reddit.ts):
//   GET /v1/reddit/search?query=author:<h>&sort=new&timeframe=all[&after]
//   GET /v1/reddit/subreddit?subreddit=<slug>&sort=new[&after]
// Both return the spike-frozen envelope { success, posts:[...], after }. Beyond the
// happy path the mock reproduces three real behaviours, so the gate can actually fail
// on them: it REQUIRES the x-api-key header (401 otherwise), it 400s a subreddit
// request carrying `timeframe` without sort=top (12-SPIKE Q6, confirmed live), and the
// author feed PAGINATES — page 1 hands out a cursor, page 2 is terminal (after:null),
// so the walker's pagination + end-of-feed handling runs for real.
//
// PORT is read from SCRAPECREATORS_MOCK_PORT (exported by the smoke flow before spawn).

import { createServer } from "node:http";

const PORT = Number(process.env.SCRAPECREATORS_MOCK_PORT || "0");

// The key the smoke flow hands the app container (-e SCRAPECREATORS_API_KEY=mock-key).
// The mock rejects anything else, so the gate proves the app actually authenticates.
const EXPECTED_API_KEY = process.env.SCRAPECREATORS_MOCK_API_KEY || "mock-key";

// A single well-formed post. `name` (t3_ fullname) is the externalId; created_utc stays
// inside the initial-backfill window so this long-lived smoke fixture cannot age out.
// The author/subreddit are echoed from the request so both walk modes resolve a
// matching subject.
function post(author, subreddit, shortId = "smoke01") {
  return {
    name: `t3_${shortId}`,
    id: shortId,
    author,
    author_fullname: "t2_smoke",
    subreddit,
    title: "Smoke gate mock devlog",
    selftext: "the smoke body",
    score: 21,
    num_comments: 3,
    upvote_ratio: 0.95,
    created_utc: Math.floor(Date.now() / 1000) - 60 * 60,
    permalink: `/r/${subreddit}/comments/${shortId}/smoke_gate_mock_devlog/`,
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let body = null;

  // Authenticate like the real API does. Without this the mock answers 200 to an
  // UNAUTHENTICATED request, so a regression that drops the x-api-key header ships
  // green here and only fails against the live provider. Doubles as the only
  // coverage of redditFetch's 401 -> operator-issue branch.
  if (req.headers["x-api-key"] !== EXPECTED_API_KEY) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "invalid api key" }));
    return;
  }

  // The subreddit endpoint 400s on `timeframe` unless sort=top (12-SPIKE Q6, confirmed
  // live). Reproduce it so the gate catches a copy-paste of the author branch's
  // timeframe=all rather than shipping a request the real API rejects.
  if (
    url.pathname === "/v1/reddit/subreddit" &&
    url.searchParams.has("timeframe") &&
    url.searchParams.get("sort") !== "top"
  ) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ success: false, error: "You need to sort by 'top' to provide a timeframe" }),
    );
    return;
  }

  if (url.pathname === "/v1/reddit/search") {
    // query=author:<handle> → echo the handle as the post author.
    const q = url.searchParams.get("query") || "";
    const author = q.replace(/^author:/, "") || "smokeauthor";
    // TWO pages when no cursor is given, so the walker's pagination + terminal
    // null-`after` handling is exercised end-to-end rather than assumed. Page 1 hands
    // out a cursor; page 2 is terminal.
    body = url.searchParams.has("after")
      ? { success: true, posts: [post(`${author}`, "gamedev", "smoke02")], after: null }
      : { success: true, posts: [post(author, "gamedev")], after: "smoke-page-2" };
  } else if (url.pathname === "/v1/reddit/subreddit") {
    const slug = url.searchParams.get("subreddit") || "gamedev";
    body = { success: true, posts: [post("smokeauthor", slug)], after: null };
  }

  if (body === null) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "not found" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});

server.listen(PORT, () => {
  // Match youtube-mock's startup line so the smoke wrapper can grep readiness.
  console.log(`[scrapecreators-mock] listening on :${PORT}`);
});

// Graceful SIGTERM (the smoke flow SIGTERMs on teardown).
process.on("SIGTERM", () => server.close(() => process.exit(0)));
