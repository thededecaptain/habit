import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject()));
    });
  });
}

/**
 * Starts a throwaway Postgres for the db test project and applies every
 * migration with `prisma migrate deploy`, exactly as production does on
 * deploy — so a migration that fails on a fresh database fails here first.
 */
export default async function setup() {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "habit-test-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "habit",
    password: "habit",
    port,
    persistent: false,
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("habit_test");

  // The migrations target Supabase, which ships these roles; the RLS
  // migration revokes access from them.
  const client = pg.getPgClient("habit_test");
  await client.connect();
  for (const role of ["anon", "authenticated", "postgres"]) {
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
  }
  await client.end();

  const url = `postgresql://habit:habit@localhost:${port}/habit_test`;
  // Test workers are forked after this runs, so they inherit these.
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;

  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    await pg.stop();
    throw new Error(`prisma migrate deploy failed on a fresh database:\n${stdout}\n${stderr}`);
  }

  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
