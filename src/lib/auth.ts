import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { db, usersTable } from "./db.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createHmac } from "node:crypto";

const JWT_SECRET = process.env.SESSION_SECRET;

if (!JWT_SECRET) {
  throw new Error("Missing required environment variable: SESSION_SECRET");
}

export interface JwtPayload {
  userId: string;
  role: string;
  credential: string;
}

export function credentialKey(passwordHash: string): string {
  return createHmac("sha256", JWT_SECRET).update(passwordHash).digest("hex");
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): JwtPayload {
  const payload = z.object({ userId: z.string().uuid(), role: z.enum(["student", "admin"]), credential: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }));
  return { userId: payload.userId, role: payload.role, credential: payload.credential };
}

async function activeUser(token: string) {
  const payload = verifyToken(token);
  const [user] = await db.select({ id: usersTable.id, role: usersTable.role, status: usersTable.status, passwordHash: usersTable.passwordHash })
    .from(usersTable).where(eq(usersTable.id, payload.userId));
  return user?.status === "active" && credentialKey(user.passwordHash) === payload.credential ? user : null;
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: string;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = authHeader.slice(7);
  try { verifyToken(token); } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  try {
    const user = await activeUser(token);
    if (!user) {
      res.status(401).json({ error: "Account unavailable or suspended" });
      return;
    }
    req.userId = user.id;
    req.userRole = user.role;
  } catch (error) { next(error); return; }
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  await requireAuth(req, res, async () => {
    if (req.userRole !== "admin") {
      res.status(403).json({ error: "Forbidden: admin only" });
      return;
    }
    next();
  });
}

export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      verifyToken(token);
    } catch {
      next();
      return;
    }
    try {
      const user = await activeUser(token);
      if (user) { req.userId = user.id; req.userRole = user.role; }
    } catch (error) { next(error); return; }
  }
  next();
}
