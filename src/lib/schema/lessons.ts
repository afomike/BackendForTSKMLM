import { jsonb, pgTable, text, timestamp, uuid, integer } from "drizzle-orm/pg-core";

export const lessonsTable = pgTable("lessons", {
  id: uuid("id").primaryKey().defaultRandom(),
  courseId: uuid("course_id").notNull(),
  title: text("title").notNull(),
  lessonOrder: integer("lesson_order").notNull(),
  contentType: text("content_type").notNull(),
  fileUrl: text("file_url").notNull(),
  parts: jsonb("parts").notNull().default([]),
  duration: integer("duration"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
