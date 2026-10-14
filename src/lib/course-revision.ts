import { db, assignmentSubmissionsTable, quizzesTable, quizAttemptsTable, userProgressTable, lessonsTable } from "./db.js";
import { eq, inArray } from "drizzle-orm";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Keep submitted work, but an approval for the previous course content needs
// review again once the student's updated training is complete.
export async function reopenCourseReview(tx: Transaction, courseId: string) {
  await tx.update(assignmentSubmissionsTable).set({ status: "pending", reviewerId: null, reviewedAt: null })
    .where(eq(assignmentSubmissionsTable.courseId, courseId));
}

export async function clearLessonQuizAttempts(tx: Transaction, lessonId: string) {
  const quizzes = await tx.select({ id: quizzesTable.id }).from(quizzesTable).where(eq(quizzesTable.lessonId, lessonId));
  if (quizzes.length) await tx.delete(quizAttemptsTable).where(inArray(quizAttemptsTable.quizId, quizzes.map(quiz => quiz.id)));
}

export async function reopenLessonCompletion(tx: Transaction, lessonId: string) {
  await tx.update(userProgressTable).set({ completed: false, completedAt: null }).where(eq(userProgressTable.lessonId, lessonId));
}

export async function withLessonRevision(
  lesson: typeof lessonsTable.$inferSelect, expected: unknown,
  write: (tx: Transaction) => Promise<void>,
): Promise<boolean> {
  return db.transaction(async tx => {
    const [current] = await tx.select().from(lessonsTable).where(eq(lessonsTable.id, lesson.id)).for("update");
    if (!current || current.updatedAt.getTime() !== lesson.updatedAt.getTime() ||
      (expected !== undefined && expected !== current.updatedAt.toISOString())) return false;
    await write(tx);
    return true;
  });
}
