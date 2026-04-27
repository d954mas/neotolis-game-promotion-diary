import { pool } from "../setup.js";

// User seed fixture. Plan 01-03 lands the `users` table; Plan 01-05 lands Better Auth
// session-cookie creation. Until Plan 03 lands the schema, the function throws a loud,
// descriptive error rather than letting pg surface a confusing relation-does-not-exist.
//
// Final shape (post-Plan-05):
//   const { id, sessionCookie } = await seedUser({ email: 'a@example.com', googleSub: 'g-1' });
//   await fetchAs(sessionCookie, '/api/me'); // 200
export interface SeedUserInput {
  email: string;
  name?: string;
  googleSub: string;
}

export interface SeededUser {
  id: string;
  email: string;
  sessionCookie: string;
}

export async function seedUser(_input: SeedUserInput): Promise<SeededUser> {
  // Plan 01-03 (schema) and Plan 01-05 (Better Auth session insert) land the implementation.
  // The throw here is intentional: turns "no schema yet" into a clear test failure.
  const { rows } = await pool
    .query<{ exists: boolean }>(
      `select exists (
         select 1 from information_schema.tables
         where table_schema = 'public' and table_name = 'users'
       ) as exists`,
    )
    .catch(() => ({ rows: [{ exists: false }] }));

  if (!rows[0]?.exists) {
    throw new Error("users table not yet created (Plan 01-03)");
  }
  // Will be filled in by Plan 01-05 — direct insert + Better Auth session row.
  throw new Error("seedUser implementation lands in Plan 01-05");
}
