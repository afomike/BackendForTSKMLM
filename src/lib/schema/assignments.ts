import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const assignmentStatusEnum = pgEnum("assignment_status", ["pending", "approved", "rejected"]);

export const assignmentSubmissionsTable = pgTable("assignment_submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  courseId: uuid("course_id").notNull(),
  submissionUrl: text("submission_url").notNull(),
  status: assignmentStatusEnum("status").notNull().default("pending"),
  reviewerId: uuid("reviewer_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
