import { Router } from "express";
import { db, usersTable, enrollmentsTable, userProgressTable } from "../lib/db.js";
import { eq, and, count, sql, inArray, or, ilike } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAdmin } from "../lib/auth.js";
import {
  UpdateUserStatusParams,
  UpdateUserStatusBody,
  CreateUserBody,
  UpdateUserRoleBody,
} from "../lib/api-zod.js";

const router = Router();

function publicUser(user: typeof usersTable.$inferSelect) {
  return { id: user.id, fullname: user.fullname, email: user.email, role: user.role,
    status: user.status, avatarUrl: user.avatarUrl ?? null, createdAt: user.createdAt.toISOString() };
}

router.post("/admin/users", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { password, ...data } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 10);
  const [existing] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${data.email}`);
  if (existing) { res.status(409).json({ error: "Email already in use" }); return; }
  const [user] = await db.insert(usersTable).values({ fullname: data.fullname, email: data.email, role: data.role, passwordHash })
    .onConflictDoNothing({ target: usersTable.email }).returning();
  if (!user) { res.status(409).json({ error: "Email already in use" }); return; }
  res.status(201).json({ ...publicUser(user), enrolledCourses: 0, completedLessons: 0 });
});

// Serialize account removals/suspensions, then recheck the acting admin inside
// the transaction so concurrent requests cannot remove the final active admin.
async function changeAccount(actorId: string, targetId: string, status?: "active" | "suspended", role?: "student" | "admin") {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(724019)`);
    const [actor] = await tx.select().from(usersTable).where(eq(usersTable.id, actorId));
    if (!actor || actor.role !== "admin" || actor.status !== "active")
      return { status: 403, error: "An active admin account is required" };
    const [target] = await tx.select().from(usersTable).where(eq(usersTable.id, targetId));
    if (!target) return { status: 404, error: "User not found" };
    if (actorId === targetId && status !== "active")
      return { status: 409, error: "You cannot delete, suspend or change the role of your own account" };
    const removesAdmin = status === "suspended" || role === "student" || (!status && !role);
    if (target.role === "admin" && target.status === "active" && removesAdmin) {
      const [total] = await tx.select({ value: count() }).from(usersTable)
        .where(and(eq(usersTable.role, "admin"), eq(usersTable.status, "active")));
      if (total.value <= 1) return { status: 409, error: "At least one active admin must remain" };
    }
    if (status || role) {
      const [user] = await tx.update(usersTable).set(status ? { status } : { role }).where(eq(usersTable.id, targetId)).returning();
      return { status: 200, user: publicUser(user) };
    }
    await tx.delete(usersTable).where(eq(usersTable.id, targetId));
    return { status: 204 };
  });
}

router.delete("/admin/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdateUserStatusParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid user ID" }); return; }
  const result = await changeAccount(req.userId!, parsed.data.id);
  if (result.error) { res.status(result.status).json({ error: result.error }); return; }
  res.status(204).end();
});

router.patch("/admin/users/:id/role", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateUserStatusParams.safeParse(req.params);
  const body = UpdateUserRoleBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Provide a valid user ID and role" }); return; }
  const result = await changeAccount(req.userId!, params.data.id, undefined, body.data.role);
  if (result.error) { res.status(result.status).json({ error: result.error }); return; }
  res.json(result.user);
});

router.get("/admin/users", requireAdmin, async (req, res): Promise<void> => {
  const parsed = z.object({ page: z.coerce.number().int().min(1).max(1_000_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    search: z.string().trim().max(200).optional(),
    role: z.enum(["student", "admin"]).optional(),
    status: z.enum(["active", "suspended"]).optional(),
  }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid pagination" }); return; }
  const page = parsed.data.page ?? 1;
  const limit = parsed.data.limit ?? (parsed.data.page ? 50 : 0);
  const hasPagination = limit > 0;

  // Treat SQL LIKE wildcard characters as literal search input.
  const search = parsed.data.search?.replace(/[\\%_]/g, value => `\\${value}`);
  const filter = and(
    search ? or(ilike(usersTable.fullname, `%${search}%`), ilike(usersTable.email, `%${search}%`)) : undefined,
    parsed.data.role ? eq(usersTable.role, parsed.data.role) : undefined,
    parsed.data.status ? eq(usersTable.status, parsed.data.status) : undefined,
  );
  const baseQuery = db.select().from(usersTable).where(filter).orderBy(usersTable.createdAt, usersTable.id);
  const users = hasPagination ? await baseQuery.limit(limit).offset((page - 1) * limit) : await baseQuery;

  if (hasPagination) {
    const [totalResult] = await db.select({ count: count() }).from(usersTable).where(filter);
    res.set("X-Total-Count", String(totalResult?.count ?? 0));
    res.set("X-Page", String(page));
    res.set("X-Page-Size", String(limit));
  }

  const ids = users.map(user => user.id);
  const [enrollments, completed] = ids.length ? await Promise.all([
    db.select({ userId: enrollmentsTable.userId, value: count() }).from(enrollmentsTable)
      .where(inArray(enrollmentsTable.userId, ids)).groupBy(enrollmentsTable.userId),
    db.select({ userId: userProgressTable.userId, value: count() }).from(userProgressTable)
      .where(and(inArray(userProgressTable.userId, ids), eq(userProgressTable.completed, true))).groupBy(userProgressTable.userId),
  ]) : [[], []];
  const enrollmentCounts = new Map(enrollments.map(row => [row.userId, row.value]));
  const completedCounts = new Map(completed.map(row => [row.userId, row.value]));
  const enriched = users.map(user => ({ ...publicUser(user),
    enrolledCourses: enrollmentCounts.get(user.id) ?? 0, completedLessons: completedCounts.get(user.id) ?? 0 }));

  res.json(enriched);
});

router.patch("/admin/users/:id/status", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateUserStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateUserStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const result = await changeAccount(req.userId!, params.data.id, parsed.data.status);
  if (result.error) { res.status(result.status).json({ error: result.error }); return; }
  res.json(result.user);
});

export default router;
