import { boolean, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

export const enrollmentsTable = pgTable("enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  courseId: uuid("course_id").notNull(),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
  active: boolean("active").notNull().default(true),
});
