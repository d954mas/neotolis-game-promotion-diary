import { pool } from "../setup.js";

// User seed fixture.
//
// Shape:
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
    throw new Error("users table not yet created");
  }
  // Direct insert + Better Auth session row.
  throw new Error("seedUser implementation lands in a later plan");
}
