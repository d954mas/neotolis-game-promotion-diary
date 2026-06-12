// TikTok short-link resolution — vm.tiktok.com / vt.tiktok.com → canonical
// /@<handle>/video/<id> URL (D-06).
//
// TikTok's share sheet hands out `vm.tiktok.com/<code>` / `vt.tiktok.com/<code>`
// short links that 301/302 to the real `tiktok.com/@<handle>/video/<id>` URL.
// The pure parser (url.ts) deliberately does NOT accept the short hosts — they
// carry no aweme id in the path. This module does the ONE network hop to expand
// them, so url.ts stays pure (the registry iterates parseUrl with no I/O).
//
// PROVIDER-AGNOSTIC boundary (D-06): this module hits tiktok.com DIRECTLY, never
// ScrapeCreators — short-link expansion is a property of the URL, not of the
// scraper vendor. It carries no x-api-key and spends no provider credit.
//
// Contract:
//   - input host NOT a short host → return the input UNCHANGED (the caller feeds
//     it straight to tiktokParseUrl; nothing to resolve).
//   - input host IS a short host → ONE redirect hop (manual redirect, read
//     Location). A canonical tiktok.com final host → return the canonical URL.
//     A non-tiktok final host (open-redirect / dead link) → null.
//   - network failure / timeout → throw AdapterError(transient) (mirrors the
//     http.ts fetchWithTimeout AbortController pattern); the caller retries.

import { AdapterError } from "$lib/sources/errors.js";

const SHORT_HOSTS = new Set(["vm.tiktok.com", "vt.tiktok.com"]);
const CANONICAL_HOSTS = new Set(["tiktok.com", "www.tiktok.com"]);

/** Read the hostname of a candidate URL string, lowercased. null when the input
 *  is not a parseable absolute URL. */
function hostOf(input: string): string | null {
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Resolve a TikTok short link (vm./vt.) to its canonical video URL via ONE
 * redirect hop. A non-short input passes through unchanged; a short link whose
 * redirect lands off TikTok returns null; a network/timeout failure throws
 * AdapterError(transient).
 *
 * The hop uses `redirect: "manual"` + reads the `Location` header (one hop, no
 * loop) with an AbortController short timeout — mirrors http.ts fetchWithTimeout.
 */
export async function resolveTikTokShortLink(
  input: string,
  timeoutMs = 10_000,
): Promise<string | null> {
  const host = hostOf(input.trim());
  // Not a short host (including unparseable input) → nothing to resolve.
  if (host === null || !SHORT_HOSTS.has(host)) return input;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(input.trim(), { redirect: "manual", signal: ac.signal });
  } catch (err) {
    const status = err instanceof DOMException && err.name === "AbortError" ? "timeout" : "error";
    throw new AdapterError(`tiktok short-link resolve ${status}`, {
      category: "transient",
      cause: err,
      context: { host, logTag: "tiktok.short-link" },
    });
  } finally {
    clearTimeout(timer);
  }

  const location = resp.headers.get("location");
  if (location === null) return null;

  const finalHost = hostOf(location);
  // An open-redirect or dead short link can land off TikTok — reject it (a
  // non-tiktok final host is not a valid video URL).
  if (finalHost === null || !CANONICAL_HOSTS.has(finalHost)) return null;

  return location;
}
