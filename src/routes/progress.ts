import { Router } from "express";
import { db, userProgressTable, lessonsTable, enrollmentsTable, coursesTable, quizzesTable, quizAttemptsTable, assignmentSubmissionsTable } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import {
  GetCourseProgressParams,
  GetCertificateParams,
} from "../lib/api-zod.js";

const router = Router();

async function hasPassedLessonQuiz(userId: string, lessonId: string): Promise<boolean> {
  const [quiz] = await db
    .select()
    .from(quizzesTable)
    .where(eq(quizzesTable.lessonId, lessonId));

  if (!quiz) {
    return true;
  }

  const [bestAttempt] = await db
    .select()
    .from(quizAttemptsTable)
    .where(
      and(
        eq(quizAttemptsTable.quizId, quiz.id),
        eq(quizAttemptsTable.userId, userId)
      )
    )
    .orderBy(desc(quizAttemptsTable.score));

  return !!bestAttempt?.passed;
}

// ---------------------------------------------------------------------------
// POST /api/lessons/:id/complete
// (was: POST /progress/complete with lessonId in body — now matches frontend,
// lessonId comes from the URL param)
// ---------------------------------------------------------------------------
router.post("/lessons/:id/complete", requireAuth, async (req, res): Promise<void> => {
  const lessonId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!lessonId) {
    res.status(400).json({ error: "Lesson id is required" });
    return;
  }

  // check lesson exists
  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId));

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  // check enrolled
  const [enrollment] = await db
    .select()
    .from(enrollmentsTable)
    .where(
      and(
        eq(enrollmentsTable.userId, req.userId!),
        eq(enrollmentsTable.courseId, lesson.courseId)
      )
    );

  if (!enrollment) {
    res.status(403).json({ error: "Not enrolled in this course" });
    return;
  }

  const quizPassed = await hasPassedLessonQuiz(req.userId!, lessonId);
  if (!quizPassed) {
    res.status(403).json({ error: "You must pass the lesson quiz before marking this lesson complete." });
    return;
  }

  await db
    .insert(userProgressTable)
    .values({
      userId: req.userId!,
      lessonId,
      completed: true,
      completedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userProgressTable.userId, userProgressTable.lessonId],
      set: { completed: true, completedAt: new Date() },
    });

  res.json({ message: "Lesson marked as completed" });
});

router.post("/lessons/:id/parts/:partId/complete", requireAuth, async (req, res): Promise<void> => {
  const lessonId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const partId = Array.isArray(req.params.partId) ? req.params.partId[0] : req.params.partId;
  if (!lessonId || !partId) {
    res.status(400).json({ error: "Lesson id and part id are required" });
    return;
  }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId));
  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  const [enrollment] = await db
    .select()
    .from(enrollmentsTable)
    .where(and(eq(enrollmentsTable.userId, req.userId!), eq(enrollmentsTable.courseId, lesson.courseId)));
  if (!enrollment) {
    res.status(403).json({ error: "Not enrolled in this course" });
    return;
  }

  const lessonParts = Array.isArray(lesson.parts) ? lesson.parts as Array<{ partId?: string }> : [];
  const knownPartIds = lessonParts.map((part, index) => part.partId ?? `legacy-${lesson.id}-${index}`);
  if (!knownPartIds.includes(partId)) {
    res.status(400).json({ error: "Part id is not part of this lesson" });
    return;
  }

  const [existing] = await db
    .select()
    .from(userProgressTable)
    .where(and(eq(userProgressTable.userId, req.userId!), eq(userProgressTable.lessonId, lessonId)));
  const completedPartsSet = new Set<string>();
  for (const savedPart of existing?.completedParts ?? []) {
    if (typeof savedPart === "string" && knownPartIds.includes(savedPart)) {
      completedPartsSet.add(savedPart);
    }
  }
  completedPartsSet.add(partId);
  const completedParts = Array.from(completedPartsSet);

  await db
    .insert(userProgressTable)
    .values({ userId: req.userId!, lessonId, completedParts })
    .onConflictDoUpdate({
      target: [userProgressTable.userId, userProgressTable.lessonId],
      set: { completedParts },
    });

  res.json({ completedPartIndexes: completedParts });
});

// ---------------------------------------------------------------------------
// PATCH /api/lessons/:id/progress
// (new — frontend called this but backend had no matching route at all)
// ---------------------------------------------------------------------------
router.patch("/lessons/:id/progress", requireAuth, async (req, res): Promise<void> => {
  const lessonId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!lessonId) {
    res.status(400).json({ error: "Lesson id is required" });
    return;
  }

  const { completed } = req.body ?? {};

  // check lesson exists
  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId));

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  // check enrolled
  const [enrollment] = await db
    .select()
    .from(enrollmentsTable)
    .where(
      and(
        eq(enrollmentsTable.userId, req.userId!),
        eq(enrollmentsTable.courseId, lesson.courseId)
      )
    );

  if (!enrollment) {
    res.status(403).json({ error: "Not enrolled in this course" });
    return;
  }

  const isCompleted = Boolean(completed);

  if (isCompleted) {
    const quizPassed = await hasPassedLessonQuiz(req.userId!, lessonId);
    if (!quizPassed) {
      res.status(403).json({ error: "You must pass the lesson quiz before marking this lesson complete." });
      return;
    }
  }

  await db
    .insert(userProgressTable)
    .values({
      userId: req.userId!,
      lessonId,
      completed: isCompleted,
      completedAt: isCompleted ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: [userProgressTable.userId, userProgressTable.lessonId],
      set: { completed: isCompleted, completedAt: isCompleted ? new Date() : null },
    });

  res.json({ message: "Progress updated", completed: isCompleted });
});

// ---------------------------------------------------------------------------
// GET /api/student/progress
// (was: GET /progress/me — renamed to match frontend's useGetMyProgress)
// ---------------------------------------------------------------------------
router.get("/student/progress", requireAuth, async (req, res): Promise<void> => {
  const enrollments = await db
    .select({
      courseId: enrollmentsTable.courseId,
    })
    .from(enrollmentsTable)
    .where(eq(enrollmentsTable.userId, req.userId!));

  const courseIds = enrollments.map((e) => e.courseId);

  const enrolledCourses = [];
  for (const courseId of courseIds) {
    const [course] = await db
      .select()
      .from(coursesTable)
      .where(eq(coursesTable.id, courseId));
    if (!course) continue;

    const lessons = await db
      .select({ id: lessonsTable.id })
      .from(lessonsTable)
      .where(eq(lessonsTable.courseId, courseId));

    const progressRows = await db
      .select()
      .from(userProgressTable)
      .where(
        and(
          eq(userProgressTable.userId, req.userId!),
          eq(userProgressTable.completed, true)
        )
      );

    const completedInCourse = progressRows.filter((p) =>
      lessons.some((l) => l.id === p.lessonId)
    );

    const totalLessons = lessons.length;
    const completedLessons = completedInCourse.length;
    const progressPercent = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
    const isCompleted = totalLessons > 0 && completedLessons === totalLessons;

    const lastActivity = completedInCourse
      .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))[0];

    enrolledCourses.push({
      courseId: course.id,
      courseTitle: course.title,
      thumbnailUrl: course.thumbnailUrl ?? null,
      totalLessons,
      completedLessons,
      progressPercent,
      isCompleted,
      lastActivityAt: lastActivity?.completedAt?.toISOString() ?? null,
    });
  }

  const allProgressRows = await db
    .select()
    .from(userProgressTable)
    .where(
      and(
        eq(userProgressTable.userId, req.userId!),
        eq(userProgressTable.completed, true)
      )
    );

  res.json({
    totalEnrolled: enrollments.length,
    totalCompleted: enrolledCourses.filter((c) => c.isCompleted).length,
    totalLessons: enrolledCourses.reduce((sum, c) => sum + c.totalLessons, 0),
    completedLessons: allProgressRows.length,
    enrolledCourses,
  });
});

// ---------------------------------------------------------------------------
// GET /api/courses/:courseId/progress
// (was: GET /progress/course/:courseId — renamed for consistency with the
// ---------------------------------------------------------------------------
router.get("/courses/:courseId/progress", requireAuth, async (req, res): Promise<void> => {
  const params = GetCourseProgressParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { courseId } = params.data;

  const [course] = await db
    .select()
    .from(coursesTable)
    .where(eq(coursesTable.id, courseId));

  if (!course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }

  const lessons = await db
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(eq(lessonsTable.courseId, courseId));

  const progressRows = await db
    .select()
    .from(userProgressTable)
    .where(
      and(
        eq(userProgressTable.userId, req.userId!),
        eq(userProgressTable.completed, true)
      )
    );

  const completedInCourse = progressRows.filter((p) =>
    lessons.some((l) => l.id === p.lessonId)
  );

  const totalLessons = lessons.length;
  const completedLessons = completedInCourse.length;
  const progressPercent = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
  const isCompleted = totalLessons > 0 && completedLessons === totalLessons;

  const lastActivity = completedInCourse
    .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))[0];

  res.json({
    courseId: course.id,
    courseTitle: course.title,
    thumbnailUrl: course.thumbnailUrl ?? null,
    totalLessons,
    completedLessons,
    progressPercent,
    isCompleted,
    lastActivityAt: lastActivity?.completedAt?.toISOString() ?? null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/certificates/:courseId
// (unchanged — already matched the frontend)
// ---------------------------------------------------------------------------
router.get("/certificates/:courseId", requireAuth, async (req, res): Promise<void> => {
  const params = GetCertificateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { courseId } = params.data;

  const [course] = await db
    .select()
    .from(coursesTable)
    .where(eq(coursesTable.id, courseId));

  if (!course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }

  const lessons = await db
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(eq(lessonsTable.courseId, courseId));

  if (lessons.length === 0) {
    res.status(404).json({ error: "Course has no lessons" });
    return;
  }

  const progressRows = await db
    .select()
    .from(userProgressTable)
    .where(
      and(
        eq(userProgressTable.userId, req.userId!),
        eq(userProgressTable.completed, true)
      )
    );

  const completedLessonIds = new Set(progressRows.map((p) => p.lessonId));
  const allCompleted = lessons.every((l) => completedLessonIds.has(l.id));

  if (!allCompleted) {
    res.status(404).json({ error: "Course not yet completed" });
    return;
  }

  const { usersTable: usersT } = await import("../lib/db.js");
  const [user] = await db.select().from(usersT).where(eq(usersT.id, req.userId!));

  const lastCompleted = progressRows
    .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))[0];

  const certNumber = `CERT-${courseId.slice(0, 8).toUpperCase()}-${req.userId!.slice(0, 8).toUpperCase()}`;

  res.json({
    id: certNumber,
    studentName: user?.fullname ?? "Student",
    courseTitle: course.title,
    completedAt: lastCompleted?.completedAt?.toISOString() ?? new Date().toISOString(),
    certificateNumber: certNumber,
  });
});

export default router;