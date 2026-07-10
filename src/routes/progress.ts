import { Router } from "express";
import { db, userProgressTable, lessonsTable, enrollmentsTable, coursesTable } from "../lib/db.js";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import {
  GetCourseProgressParams,
  GetCertificateParams,
} from "../lib/api-zod.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/lessons/:id/complete
// (was: POST /progress/complete with lessonId in body — now matches frontend,
// lessonId comes from the URL param)
// ---------------------------------------------------------------------------
router.post("/lessons/:id/complete", requireAuth, async (req, res): Promise<void> => {
  const lessonId = req.params.id;

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

// ---------------------------------------------------------------------------
// PATCH /api/lessons/:id/progress
// (new — frontend called this but backend had no matching route at all)
// ---------------------------------------------------------------------------
router.patch("/lessons/:id/progress", requireAuth, async (req, res): Promise<void> => {
  const lessonId = req.params.id;
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