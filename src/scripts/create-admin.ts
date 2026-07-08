import bcrypt from "bcryptjs";
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
  const password = args.password;
  const fullname = args.fullname ?? "Administrator";

  if (!email || !password) {
    console.error("Usage: npm run create-admin -- --email admin@example.com --password YourStrongPassword [--fullname 'Admin Name']");
    process.exit(1);
  }

  const existingAdmin = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email));

  if (existingAdmin.length > 0) {
    console.log(`User with email ${email} already exists. No changes made.`);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const [user] = await db
    .insert(usersTable)
    .values({ fullname, email, passwordHash, role: "admin" })
    .returning();

  console.log("Admin user created successfully:");
  console.log(`  id: ${user.id}`);
  console.log(`  fullname: ${user.fullname}`);
  console.log(`  email: ${user.email}`);
  console.log(`  role: ${user.role}`);
}

main().catch((err) => {
  console.error("Failed to create admin user:", err);
  process.exit(1);
});
