import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { coursesTable } from "./courses.js";

export const lessonsTable = pgTable(
  "lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    lessonOrder: integer("lesson_order").notNull(),
    contentType: text("content_type").notNull(),
    fileUrl: text("file_url").notNull(),
    parts: jsonb("parts").notNull().default([]),
    duration: integer("duration"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => ({
    courseIdIdx: index("lessons_course_id_idx").on(table.courseId),
    courseOrderUnique: unique("lessons_course_order_unique").on(table.courseId, table.lessonOrder),
  }),
);
