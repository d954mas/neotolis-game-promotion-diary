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
// Both return the spike-frozen envelope { success, posts:[...], after }. The mock
// serves ONE terminal page (after:null ⇒ end-of-feed) carrying one well-formed post,
// so a single walk imports exactly one event + one snapshot and then completes.
//
// PORT is read from SCRAPECREATORS_MOCK_PORT (exported by the smoke flow before spawn).

import { createServer } from "node:http";

const PORT = Number(process.env.SCRAPECREATORS_MOCK_PORT || "0");

// A single well-formed post. `name` (t3_ fullname) is the externalId; created_utc is a
// fixed epoch so the walk is deterministic. The author/subreddit are echoed from the
// request so both walk modes resolve a matching subject.
function post(author, subreddit) {
  return {
    name: "t3_smoke01",
    id: "smoke01",
    author,
    author_fullname: "t2_smoke",
    subreddit,
    title: "Smoke gate mock devlog",
    selftext: "the smoke body",
    score: 21,
    num_comments: 3,
    upvote_ratio: 0.95,
    created_utc: 1_780_000_000,
    permalink: `/r/${subreddit}/comments/smoke01/smoke_gate_mock_devlog/`,
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let body = null;

  if (url.pathname === "/v1/reddit/search") {
    // query=author:<handle> → echo the handle as the post author.
    const q = url.searchParams.get("query") || "";
    const author = q.replace(/^author:/, "") || "smokeauthor";
    body = { success: true, posts: [post(author, "gamedev")], after: null };
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
