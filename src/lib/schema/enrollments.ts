import { boolean, index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { coursesTable } from "./courses.js";
import { usersTable } from "./users.js";

export const enrollmentsTable = pgTable(
  "enrollments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    active: boolean("active").notNull().default(true),
  },
  (table) => ({
    userCourseUnique: unique("enrollments_user_course_unique").on(table.userId, table.courseId),
    userIdIdx: index("enrollments_user_id_idx").on(table.userId),
    courseIdIdx: index("enrollments_course_id_idx").on(table.courseId),
  }),
);
