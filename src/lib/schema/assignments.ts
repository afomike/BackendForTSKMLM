import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { coursesTable } from "./courses.js";
import { usersTable } from "./users.js";

export const assignmentStatusEnum = pgEnum("assignment_status", ["pending", "approved", "rejected"]);

export const assignmentSubmissionsTable = pgTable(
  "assignment_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    submissionUrl: text("submission_url").notNull(),
    status: assignmentStatusEnum("status").notNull().default("pending"),
    reviewerId: uuid("reviewer_id").references(() => usersTable.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => ({
    userIdIdx: index("assignment_submissions_user_id_idx").on(table.userId),
    courseIdIdx: index("assignment_submissions_course_id_idx").on(table.courseId),
  }),
);
