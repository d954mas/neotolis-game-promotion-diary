import { describe, it } from 'vitest';

// Wave 0 placeholder for VALIDATION ad-hoc DTO discipline (PITFALLS P3).
// Plan 01-05 (auth) lands the User DTO; Plan 01-07 (tenant scope) lands the response-shape
// allow-list so we never accidentally serialize internal IDs / hashes / google_sub.
describe('DTO discipline', () => {
  it.skip('user DTO never includes google_sub', () => {
    /* Plan 01-05 — assert the API response shape does not contain googleSub / google_sub */
  });

  it.skip('any API response field < 8 hex chars is allow-listed', () => {
    /* Plan 01-07 — guard against accidentally returning short hashed/internal IDs */
  });
});
