import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * drizzle-kit check validates the snapshot graph but never reads the TypeScript
 * schema. A generate that appends a journal entry is therefore the actual drift
 * signal.
 *
 * @param {{ entries?: unknown[] }} before
 * @param {{ entries?: unknown[] }} after
 */
export function journalHasSchemaDrift(before, after) {
  return JSON.stringify(before.entries ?? []) !== JSON.stringify(after.entries ?? []);
}

function toCliPath(path) {
  return path.replaceAll("\\", "/");
}

async function readJournal(migrationsDir) {
  const raw = await readFile(join(migrationsDir, "meta", "_journal.json"), "utf8");
  return JSON.parse(raw);
}

export async function checkDbSchemaDrift(rootDir = process.cwd()) {
  const tempRoot = await mkdtemp(join(rootDir, ".db-schema-drift-"));
  const tempMigrations = join(tempRoot, "drizzle");
  try {
    await cp(join(rootDir, "drizzle"), tempMigrations, { recursive: true });
    const before = await readJournal(tempMigrations);
    const drizzleKit = join(rootDir, "node_modules", "drizzle-kit", "bin.cjs");
    const schema = join(rootDir, "src", "lib", "server", "db", "schema", "index.ts");
    const result = spawnSync(
      process.execPath,
      [
        drizzleKit,
        "generate",
        "--dialect=postgresql",
        `--schema=${toCliPath(schema)}`,
        `--out=${toCliPath(tempMigrations)}`,
        "--name=ci_schema_drift",
      ],
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `drizzle-kit generate failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
      );
    }

    const after = await readJournal(tempMigrations);
    if (journalHasSchemaDrift(before, after)) {
      throw new Error(
        "Database schema drift detected. Run `pnpm db:generate` and commit the result.",
      );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkDbSchemaDrift()
    .then(() => {
      console.log("Database schema matches the latest migration snapshot.");
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
