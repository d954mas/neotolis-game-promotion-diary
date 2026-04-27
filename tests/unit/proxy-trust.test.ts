import { describe, it } from 'vitest';

// Wave 0 placeholder for VALIDATION behavior 20 (trusted-proxy headers).
// Plan 01-06 (Wave 3) lands src/lib/server/http/middleware/proxy-trust.ts with PT1–PT6.
describe('trusted-proxy middleware', () => {
  it.skip('PT1: untrusted source → use socket peer, ignore X-Forwarded-For', () => {
    /* Plan 01-06 */
  });

  it.skip('PT2: trusted source multi-hop XFF → walk right-to-left, drop trusted hops', () => {
    /* Plan 01-06 */
  });

  it.skip('PT3: XFF spoofing rejected (CVE-2026-27700 mitigation)', () => {
    /* Plan 01-06 */
  });

  it.skip('PT4: CF-Connecting-IP honored only from Cloudflare CIDRs', () => {
    /* Plan 01-06 */
  });

  it.skip('PT5: CF-Connecting-IP ignored from untrusted source', () => {
    /* Plan 01-06 */
  });

  it.skip('PT6: X-Forwarded-Proto trust gate (HSTS-relevant)', () => {
    /* Plan 01-06 */
  });
});
