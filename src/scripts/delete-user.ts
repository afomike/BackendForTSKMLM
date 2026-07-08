import { eq } from "drizzle-orm";
import { db, usersTable } from "../lib/db.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const values: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--") && i + 1 < args.length) {
      values[arg.slice(2)] = args[i + 1];
      i += 1;
    }
  }

  return values;
}

async function main() {
  const args = parseArgs();
  const email = args.email;

  if (!email) {
    console.error("Usage: npm run delete-user -- --email admin@example.com");
    process.exit(1);
  }

  const result = await db
    .delete(usersTable)
    .where(eq(usersTable.email, email))
    .returning();

  if (result.length === 0) {
    console.log(`No user found with email ${email}.`);
    process.exit(0);
  }

  console.log(`Deleted user with email ${email}:`);
  console.log(`  id: ${result[0].id}`);
  console.log(`  role: ${result[0].role}`);
}

main().catch((err) => {
  console.error("Failed to delete user:", err);
  process.exit(1);
});
