import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

const { Pool } = pg;

export function resolveDatabaseConfig() {
  const isProduction = process.env.NODE_ENV === "production";
  const connectionString = isProduction
    ? process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL
    : process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "No database connection string configured. Set DATABASE_URL for local development or NEON_DATABASE_URL for production.",
    );
  }

  return {
    connectionString,
    isProduction,
    pool: {
      connectionString,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      application_name: "tskmlm-api",
      ...(isProduction ? { ssl: { rejectUnauthorized: false } } : {}),
    },
  };
}

const { connectionString, pool: poolConfig } = resolveDatabaseConfig();

export const pool = new Pool(poolConfig);
export const db = drizzle(pool, { schema });

export * from "./schema/index.js";
export { connectionString };
