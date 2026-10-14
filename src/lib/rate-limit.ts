import type { RequestHandler } from "express";

// Per-process protection. Multi-instance deployments should also enforce limits
// at their shared gateway. No timers are needed, so tests/shutdown stay clean.
export function rateLimit(max: number, windowMs = 15 * 60 * 1000, now = Date.now): RequestHandler {
  const entries = new Map<string, { count: number; expires: number }>();
  return (req, res, next) => {
    const timestamp = now();
    if (entries.size >= 10_000) {
      for (const [key, entry] of entries) if (entry.expires <= timestamp) entries.delete(key);
    }
    const key = req.ip || req.socket.remoteAddress || "unknown";
    let entry = entries.get(key);
    if (!entry || entry.expires <= timestamp) {
      if (entries.size >= 10_000 && !entry) {
        res.set("Retry-After", "60").status(429).json({ error: "Too many requests. Try again shortly." });
        return;
      }
      entry = { count: 0, expires: timestamp + windowMs };
      entries.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((entry.expires - timestamp) / 1000))))
        .status(429).json({ error: "Too many attempts. Please try again later." });
      return;
    }
    next();
  };
}
