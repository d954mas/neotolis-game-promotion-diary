import type { PoolClient } from "pg";
import { pool } from "../setup.js";

// Per-test transactional Postgres helpers (BEGIN/SAVEPOINT/ROLLBACK pattern from
// 01-VALIDATION.md "Test Infrastructure"). Used by tests that want stricter isolation
// than per-suite TRUNCATE — e.g. fuzz-style invariant checks where many small mutations
// must each roll back independently.
//
// Usage:
//   await withTx(async (client) => {
//     await client.query('INSERT INTO users ...');
//     // assertions; everything rolls back at end of fn regardless of pass/fail
//   });
//
// Pre-Plan-03 the schema is empty; helper still works (you just have nothing to write).
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("ROLLBACK");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

// Convenience: open a fresh nested SAVEPOINT inside an existing tx.
export async function withSavepoint<T>(
  client: PoolClient,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}
