import { boolean, index, jsonb, pgTable, timestamp, uuid, unique } from "drizzle-orm/pg-core";
import { lessonsTable } from "./lessons.js";
import { usersTable } from "./users.js";

export const userProgressTable = pgTable(
  "user_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    lessonId: uuid("lesson_id")
      .notNull()
      .references(() => lessonsTable.id, { onDelete: "cascade" }),
    completed: boolean("completed").notNull().default(false),
    completedParts: jsonb("completed_parts").$type<number[]>().notNull().default([]),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userLessonUnique: unique("user_progress_user_lesson_unique").on(table.userId, table.lessonId),
    userIdIdx: index("user_progress_user_id_idx").on(table.userId),
    lessonIdIdx: index("user_progress_lesson_id_idx").on(table.lessonId),
  }),
);