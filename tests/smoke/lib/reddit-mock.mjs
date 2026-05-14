// Mock Reddit reverse-proxy for the smoke gate.
//
// The smoke gate MUST NOT make live Reddit calls. The adapter reaches
// Reddit through `env.REDDIT_BASE_URL_OVERRIDE` (default
// `https://www.reddit.com`); the smoke shell launches THIS stub on a
// free port and exports `REDDIT_BASE_URL_OVERRIDE=http://localhost:$port`
// onto the worker container so all Reddit traffic is intercepted here
// instead of going live.
//
// Recorded fixtures were rejected for the same reason as YouTube's stub:
// real fixtures drift on schema changes; a tiny custom stub is the
// documented choice. Separate live-spike fixtures (V12 / V13 inside the
// integration tests) pin the schema-shape assertion; this stub mirrors
// that exact shape for offline reproducibility.
//
// Endpoints implemented (matches what the Reddit adapter calls):
//   GET /comments/<id>.json                → [submission, comments] array
//                                            shape with one t3 child
//   GET /r/<sub>/new.json                  → Listing with 1 t3 child
//   GET /r/<sub>/about.json                → t5 subreddit metadata
//   GET /api/info.json?id=t3_...           → Listing (same shape as /new)
//   GET /user/<handle>/submitted.json      → Listing (1 t3 child)
//   GET /user/<handle>/about.json          → t2 user metadata
//
// Anything else returns 404 with an empty JSON body — the adapter's
// AdapterError(not-found) will surface the mismatch loudly if a future
// caller is added without extending the stub.
//
// Lifecycle: pure stdlib (`node:http`); no install. Boots on
// `process.env.REDDIT_MOCK_PORT` (or 0 = OS-assigned free port). Logs the
// resolved port to stdout so the shell wrapper can capture it.

import { createServer } from "node:http";

const PORT = Number(process.env.REDDIT_MOCK_PORT ?? 0);

// Deterministic canonical t3 (submission) child. Smoke assertions key on
// post id "abc" (full id "t3_abc") and subreddit "IndieDev".
const T3_ABC = {
  kind: "t3",
  data: {
    id: "abc",
    name: "t3_abc",
    subreddit: "IndieDev",
    subreddit_id: "t5_indiedev",
    author: "operator",
    author_fullname: "t2_operator",
    permalink: "/r/IndieDev/comments/abc/test/",
    url: "https://www.reddit.com/r/IndieDev/comments/abc/test/",
    title: "smoke test post",
    selftext: "",
    is_self: true,
    created_utc: 1746662400,
    score: 5,
    num_comments: 1,
    upvote_ratio: 0.9,
    total_awards_received: 0,
    gilded: 0,
    link_flair_text: null,
    over_18: false,
    spoiler: false,
    stickied: false,
    locked: false,
    archived: false,
    removed_by_category: null,
    crosspost_parent: null,
  },
};

// Reddit's /comments/<id>.json returns a TWO-element array:
//   [submission_listing, comments_listing]
// post-single.ts indexes [0] for the submission.
const CANNED_COMMENTS = [
  { kind: "Listing", data: { children: [T3_ABC] } },
  { kind: "Listing", data: { children: [] } },
];

const CANNED_NEW = { kind: "Listing", data: { children: [T3_ABC] } };

const CANNED_ABOUT_SUB = {
  kind: "t5",
  data: {
    display_name: "IndieDev",
    subscribers: 350000,
    accounts_active: 2400,
    public_description: "Indie dev sub",
    description: "Full sidebar",
    over18: false,
    subreddit_type: "public",
  },
};

const CANNED_ABOUT_USER = {
  kind: "t2",
  data: {
    name: "operator",
    link_karma: 1000,
    comment_karma: 500,
    total_karma: 1500,
    is_suspended: false,
    created_utc: 1600000000,
  },
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  res.setHeader("Content-Type", "application/json");

  // GET /comments/<id>.json — paste flow.
  if (/^\/comments\/[a-z0-9]+\.json$/i.test(url.pathname)) {
    res.statusCode = 200;
    res.end(JSON.stringify(CANNED_COMMENTS));
    return;
  }
  // GET /r/<sub>/new.json
  if (/^\/r\/[^/]+\/new\.json$/i.test(url.pathname)) {
    res.statusCode = 200;
    res.end(JSON.stringify(CANNED_NEW));
    return;
  }
  // GET /r/<sub>/about.json
  if (/^\/r\/[^/]+\/about\.json$/i.test(url.pathname)) {
    res.statusCode = 200;
    res.end(JSON.stringify(CANNED_ABOUT_SUB));
    return;
  }
  // GET /api/info.json — batched lookup. Smoke ignores filter; returns one t3.
  if (url.pathname === "/api/info.json") {
    res.statusCode = 200;
    res.end(JSON.stringify(CANNED_NEW));
    return;
  }
  // GET /user/<handle>/submitted.json
  if (/^\/user\/[^/]+\/submitted\.json$/i.test(url.pathname)) {
    res.statusCode = 200;
    res.end(JSON.stringify(CANNED_NEW));
    return;
  }
  // GET /user/<handle>/about.json
  if (/^\/user\/[^/]+\/about\.json$/i.test(url.pathname)) {
    res.statusCode = 200;
    res.end(JSON.stringify(CANNED_ABOUT_USER));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ message: "mock not implemented", pathname: url.pathname }));
});

server.listen(PORT, () => {
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : PORT;
  // Stdout line captured by reddit-mock.sh. Format is documented contract.
  console.log(`reddit-mock listening on :${boundPort}`);
});

// Graceful shutdown — the shell wrapper SIGTERMs us on EXIT trap.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
