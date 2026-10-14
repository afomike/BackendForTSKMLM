import { readFile } from "node:fs/promises";
import { pool } from "../lib/db.js";

// Apply only the two additive playback columns. Do not run any historical
// cleanup migrations or change existing student progress records.
async function main() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'user_progress'",
    );
    const columns = new Set(rows.map(row => row.column_name));
    if (!["id", "user_id", "lesson_id", "completed_parts", "downloaded_parts"].every(column => columns.has(column)))
      throw Object.assign(new Error("The base progress schema must be installed first."), { code: "BASE_SCHEMA_MISSING" });
    if (process.argv.includes("--check")) {
      console.log(columns.has("playback_positions") && columns.has("last_viewed_at") ? "Playback database fields already exist." : "Base schema verified. Two additive playback fields are required.");
      return;
    }
    const sql = await readFile(new URL("../../drizzle/0006_flowery_slipstream.sql", import.meta.url), "utf8");
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(sql);
      await client.query("COMMIT");
      console.log("Playback database fields are ready. Existing progress was preserved.");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  } finally { client.release(); }
}

main().catch(error => {
  console.error(`Playback migration could not finish (${typeof error?.code === "string" ? error.code : "DATABASE_ERROR"}).`);
  process.exitCode = 1;
}).finally(() => pool.end());
