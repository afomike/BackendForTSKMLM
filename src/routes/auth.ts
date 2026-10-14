import { Router, raw } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable } from "../lib/db.js";
import { eq, sql, and } from "drizzle-orm";
import { signToken, requireAuth, credentialKey } from "../lib/auth.js";
import { rateLimit } from "../lib/rate-limit.js";
import { uploadAvatar } from "../lib/avatar-upload.js";
import {
  RegisterBody,
  LoginBody,
  UpdateProfileBody,
  ChangePasswordBody,
} from "../lib/api-zod.js";

const router = Router();

router.post("/auth/avatar", requireAuth, rateLimit(10), raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "5mb" }), async (req, res): Promise<void> => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    res.status(400).json({ error: "Choose a JPG, PNG or WebP image up to 5 MB." }); return;
  }
  const avatarUrl = await uploadAvatar(req.body, req.userId!);
  const [user] = await db.update(usersTable).set({ avatarUrl }).where(eq(usersTable.id, req.userId!)).returning();
  if (!user) { res.status(401).json({ error: "Account unavailable" }); return; }
  res.json({ avatarUrl });
});

router.post("/auth/register", rateLimit(10), async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { fullname, email, password } = parsed.data;

  try {
    const [user] = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(sql`lower(${usersTable.email}) = ${email}`);

      if (existing.length > 0) {
        throw Object.assign(new Error("Email already in use"), { statusCode: 409 });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const [createdUser] = await tx
        .insert(usersTable)
        .values({ fullname, email, passwordHash, role: "student" })
        .onConflictDoNothing({ target: usersTable.email })
        .returning();

      if (!createdUser) throw Object.assign(new Error("Email already in use"), { statusCode: 409 });

      return [createdUser];
    });

    const token = signToken({ userId: user.id, role: user.role, credential: credentialKey(user.passwordHash) });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        fullname: user.fullname,
        email: user.email,
        role: user.role,
        status: user.status,
        avatarUrl: user.avatarUrl ?? null,
        createdAt: user.createdAt.toISOString(),
      },
    });
  } catch (error) {
    const statusCode = error instanceof Error && "statusCode" in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    if (statusCode === 409) {
      res.status(409).json({ error: "Email already in use" });
      return;
    }

    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/auth/login", rateLimit(30), async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { email, password } = parsed.data;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${email}`);

  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  if (user.status === "suspended") {
    res.status(401).json({ error: "Account suspended" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = signToken({ userId: user.id, role: user.role, credential: credentialKey(user.passwordHash) });

  res.json({
    token,
    user: {
      id: user.id,
      fullname: user.fullname,
      email: user.email,
      role: user.role,
      status: user.status,
      avatarUrl: user.avatarUrl ?? null,
      createdAt: user.createdAt.toISOString(),
    },
  });
});

router.post("/auth/logout", (_req, res): void => {
  res.json({ message: "Logged out successfully" });
});

router.post("/auth/password", requireAuth, rateLimit(10), async (req, res): Promise<void> => {
  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!));
  if (!existing || !(await bcrypt.compare(parsed.data.currentPassword, existing.passwordHash))) {
    res.status(400).json({ error: "Current password is incorrect" }); return;
  }
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  // Compare-and-swap prevents concurrent changes from overwriting a newer password.
  const [user] = await db.update(usersTable).set({ passwordHash })
    .where(and(eq(usersTable.id, existing.id), eq(usersTable.passwordHash, existing.passwordHash), eq(usersTable.status, "active"))).returning();
  if (!user) { res.status(409).json({ error: "Account changed. Sign in and try again." }); return; }
  res.json({ token: signToken({ userId: user.id, role: user.role, credential: credentialKey(user.passwordHash) }),
    message: "Password changed. Other sessions have been signed out." });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.userId!));

  if (!user) {
    res.status(401).json({ error: "User not found" });
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

router.patch("/auth/profile", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<{ fullname: string; avatarUrl: string | null }> = {};
  if (parsed.data.fullname != null) updates.fullname = parsed.data.fullname;
  if (parsed.data.avatarUrl !== undefined) updates.avatarUrl = parsed.data.avatarUrl || null;

  const [user] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, req.userId!))
    .returning();

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
