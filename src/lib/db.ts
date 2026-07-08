import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

const { Pool } = pg;

const isProduction = process.env.NODE_ENV === "production";
const connectionString = isProduction
  ? process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL
  : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "No database connection string configured. Set DATABASE_URL for local development or NEON_DATABASE_URL for production.",
  );
}

export const pool = new Pool({
  connectionString,
  ...(isProduction ? { ssl: { rejectUnauthorized: false } } : {}),
});
export const db = drizzle(pool, { schema });

export * from "./schema/index.js";
