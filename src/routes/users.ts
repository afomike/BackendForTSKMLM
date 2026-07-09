import { Router } from "express";
import { db, usersTable, enrollmentsTable, userProgressTable } from "../lib/db.js";
import { eq, and, count } from "drizzle-orm";
import { requireAdmin } from "../lib/auth.js";
import {
  UpdateUserStatusParams,
  UpdateUserStatusBody,
} from "../lib/api-zod.js";

const router = Router();

router.get("/admin/users", requireAdmin, async (_req, res): Promise<void> => {
  const users = await db.select().from(usersTable).orderBy(usersTable.createdAt);

  const enriched = await Promise.all(
    users.map(async (user) => {
      const [enrollCount] = await db
        .select({ count: count() })
        .from(enrollmentsTable)
        .where(eq(enrollmentsTable.userId, user.id));

      const [completedCount] = await db
        .select({ count: count() })
        .from(userProgressTable)
        .where(
          and(
            eq(userProgressTable.userId, user.id),
            eq(userProgressTable.completed, true)
          )
        );

      return {
        id: user.id,
        fullname: user.fullname,
        email: user.email,
        role: user.role,
        status: user.status,
        avatarUrl: user.avatarUrl ?? null,
        createdAt: user.createdAt.toISOString(),
        enrolledCourses: enrollCount?.count ?? 0,
        completedLessons: completedCount?.count ?? 0,
      };
    })
  );

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

  const [user] = await db
    .update(usersTable)
    .set({ status: parsed.data.status })
    .where(eq(usersTable.id, params.data.id))
    .returning();

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    id: user.id,
    fullname: user.fullname,
    email: user.email,
    role: user.role,
    status: user.status,
    avatarUrl: user.avatarUrl ?? null,
    createdAt: user.createdAt.toISOString(),
  });
});

export default router;
