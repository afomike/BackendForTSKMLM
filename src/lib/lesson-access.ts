import { db, lessonsTable, enrollmentsTable, userProgressTable } from "./db.js";
import { and, eq } from "drizzle-orm";

export function isLessonLocked(
  lessons: Array<{ id: string }>, index: number, enrolled: boolean,
  completed: Set<string>, role?: string,
): boolean {
  if (role === "admin" || index === 0) return false;
  return !enrolled || (!completed.has(lessons[index].id) && !completed.has(lessons[index - 1].id));
}

export async function lessonAccess(courseId: string, userId?: string, role?: string) {
  const lessons = await db.select({ id: lessonsTable.id }).from(lessonsTable)
    .where(eq(lessonsTable.courseId, courseId)).orderBy(lessonsTable.lessonOrder);
  let enrolled = false;
  const completed = new Set<string>();
  if (userId && role !== "admin") {
    const [enrollment] = await db.select({ id: enrollmentsTable.id }).from(enrollmentsTable)
      .where(and(eq(enrollmentsTable.courseId, courseId), eq(enrollmentsTable.userId, userId)));
    enrolled = Boolean(enrollment);
    if (enrolled) {
      const progress = await db.select({ lessonId: userProgressTable.lessonId }).from(userProgressTable)
        .where(and(eq(userProgressTable.userId, userId), eq(userProgressTable.completed, true)));
      progress.forEach(row => completed.add(row.lessonId));
    }
  }
  return new Set(lessons.filter((_lesson, index) => !isLessonLocked(lessons, index, enrolled, completed, role)).map(lesson => lesson.id));
}
