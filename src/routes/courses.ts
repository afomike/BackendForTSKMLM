import { Router } from "express";
import { db, coursesTable, lessonsTable, enrollmentsTable, userProgressTable, assignmentSubmissionsTable, quizzesTable, quizQuestionsTable, quizOptionsTable, quizAttemptsTable } from "../lib/db.js";
import { eq, count, and, ilike, inArray } from "drizzle-orm";
import { requireAuth, requireAdmin, optionalAuth } from "../lib/auth.js";
import { isLessonLocked } from "../lib/lesson-access.js";
import {
  CreateCourseBody,
  UpdateCourseBody,
  UpdateCourseParams,
  GetCourseParams,
  DeleteCourseParams,
  EnrollCourseParams,
  ListCoursesQueryParams,
} from "../lib/api-zod.js";

const router = Router();

const VALID_LESSON_TYPES = new Set(["video", "audio", "pdf"]);
function asContentType(v: unknown): "video" | "audio" | "pdf" {
  return VALID_LESSON_TYPES.has(String(v)) ? (v as "video" | "audio" | "pdf") : "video";
}

type LessonPart = {
  partId: string;
  title: string;
  contentType: string;
  fileUrl: string;
  description?: string;
  duration?: number | null;
};

function serializeLessonParts(
  parts: unknown,
  lessonId: string,
  fallback?: { title: string; contentType: "video" | "audio" | "pdf"; fileUrl: string; duration?: number | null },
): LessonPart[] {
  const serialized = Array.isArray(parts)
    ? (parts as Partial<LessonPart>[])
        .map((part, index) => ({
          partId: part.partId ?? `legacy-${lessonId}-${index}`,
          title: part.title?.trim() || (index === 0 ? fallback?.title : undefined) || `Part ${index + 1}`,
          contentType: part.contentType ?? fallback?.contentType ?? "video",
          fileUrl: part.fileUrl?.trim() || fallback?.fileUrl || "",
          description: part.description?.trim() || undefined,
          duration: part.duration ?? fallback?.duration ?? null,
        }))
        .filter((part) => part.title.length > 0 && part.fileUrl.length > 0)
    : [];

  if (serialized.length === 0 && fallback?.fileUrl) {
    return [{
      partId: `legacy-${lessonId}-0`,
      title: fallback.title,
      contentType: fallback.contentType,
      fileUrl: fallback.fileUrl,
      duration: fallback.duration ?? null,
    }];
  }
  return serialized as LessonPart[];
}

router.get("/courses", optionalAuth, async (req, res): Promise<void> => {
  const params = ListCoursesQueryParams.safeParse(req.query);
  const search = params.success ? params.data.search : undefined;
  const requestedPage = params.success ? params.data.page : undefined;
  const requestedLimit = params.success ? params.data.limit : undefined;

  const page = requestedPage ?? 1;
  const limit = requestedLimit ?? undefined;
  const offset = limit ? (page - 1) * limit : 0;

  const query = db
    .select({
      id: coursesTable.id,
      title: coursesTable.title,
      description: coursesTable.description,
      thumbnailUrl: coursesTable.thumbnailUrl,
      createdAt: coursesTable.createdAt,
      lessonCount: count(lessonsTable.id),
    })
    .from(coursesTable)
    .leftJoin(lessonsTable, eq(lessonsTable.courseId, coursesTable.id))
    .groupBy(coursesTable.id)
    .orderBy(coursesTable.createdAt);

  const paginatedQuery = limit ? query.limit(limit).offset(offset) : query;

  let courses;
  if (search) {
    const filteredQuery = db
      .select({
        id: coursesTable.id,
        title: coursesTable.title,
        description: coursesTable.description,
        thumbnailUrl: coursesTable.thumbnailUrl,
        createdAt: coursesTable.createdAt,
        lessonCount: count(lessonsTable.id),
      })
      .from(coursesTable)
      .leftJoin(lessonsTable, eq(lessonsTable.courseId, coursesTable.id))
      .where(ilike(coursesTable.title, `%${search}%`))
      .groupBy(coursesTable.id)
      .orderBy(coursesTable.createdAt);

    courses = limit ? await filteredQuery.limit(limit).offset(offset) : await filteredQuery;
  } else {
    courses = await paginatedQuery;
  }

  // get enrollment counts
  const enrollmentCounts = await db
    .select({
      courseId: enrollmentsTable.courseId,
      count: count(enrollmentsTable.id),
    })
    .from(enrollmentsTable)
    .groupBy(enrollmentsTable.courseId);

  const enrollMap = new Map(enrollmentCounts.map((e) => [e.courseId, e.count]));

  if (limit) {
    const [totalResult] = await db
      .select({ count: count() })
      .from(coursesTable)
      .where(search ? ilike(coursesTable.title, `%${search}%`) : undefined);
    res.set("X-Total-Count", String(totalResult?.count ?? 0));
    res.set("X-Page", String(page));
    res.set("X-Page-Size", String(limit));
  }

  res.json(
    courses.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      thumbnailUrl: c.thumbnailUrl ?? null,
      lessonCount: c.lessonCount,
      enrollmentCount: enrollMap.get(c.id) ?? 0,
      createdAt: c.createdAt.toISOString(),
    }))
  );
});

router.post("/courses", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateCourseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [course] = await db
    .insert(coursesTable)
    .values({
      title: parsed.data.title,
      description: parsed.data.description,
      thumbnailUrl: parsed.data.thumbnailUrl ?? null,
    })
    .returning();

  res.status(201).json({
    id: course.id,
    title: course.title,
    description: course.description,
    thumbnailUrl: course.thumbnailUrl ?? null,
    lessonCount: 0,
    enrollmentCount: 0,
    createdAt: course.createdAt.toISOString(),
  });
});

router.get("/courses/:id", optionalAuth, async (req, res): Promise<void> => {
  const params = GetCourseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [course] = await db
    .select()
    .from(coursesTable)
    .where(eq(coursesTable.id, params.data.id));

  if (!course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }

  // get lessons ordered
  const lessons = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.courseId, course.id))
    .orderBy(lessonsTable.lessonOrder);

  // check enrollment
  let isEnrolled = false;
  let completedLessonIds = new Set<string>();

  if (req.userId) {
    const [enrollment] = await db
      .select()
      .from(enrollmentsTable)
      .where(
        and(
          eq(enrollmentsTable.userId, req.userId),
          eq(enrollmentsTable.courseId, course.id)
        )
      );
    isEnrolled = !!enrollment;

    if (isEnrolled) {
      const progressRows = await db
        .select()
        .from(userProgressTable)
        .where(
          and(
            eq(userProgressTable.userId, req.userId),
            eq(userProgressTable.completed, true)
          )
        );
      completedLessonIds = new Set(progressRows.map((p) => p.lessonId));
    }
  }

  const enrollmentCount = await db
    .select({ count: count() })
    .from(enrollmentsTable)
    .where(eq(enrollmentsTable.courseId, course.id));

  // build lessons with progress & locking
  const lessonsWithProgress = lessons.map((lesson, index) => {
    const isCompleted = completedLessonIds.has(lesson.id);
    const isLocked = isLessonLocked(lessons, index, isEnrolled, completedLessonIds, req.userRole);

    return {
      id: lesson.id,
      courseId: lesson.courseId,
      title: lesson.title,
      lessonOrder: lesson.lessonOrder,
      contentType: asContentType(lesson.contentType),
      fileUrl: isLocked ? "" : lesson.fileUrl,
      parts: isLocked ? [] : serializeLessonParts(lesson.parts, lesson.id, {
        title: lesson.title,
        contentType: asContentType(lesson.contentType),
        fileUrl: lesson.fileUrl,
        duration: lesson.duration,
      }),
      duration: lesson.duration ?? null,
      createdAt: lesson.createdAt.toISOString(),
      isCompleted,
      isLocked,
      completedAt: null,
    };
  });

  res.json({
    id: course.id,
    title: course.title,
    description: course.description,
    thumbnailUrl: course.thumbnailUrl ?? null,
    lessonCount: lessons.length,
    enrollmentCount: enrollmentCount[0]?.count ?? 0,
    createdAt: course.createdAt.toISOString(),
    lessons: lessonsWithProgress,
    isEnrolled,
  });
});

router.patch("/courses/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateCourseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateCourseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<{ title: string; description: string; thumbnailUrl: string | null }> = {};
  if (parsed.data.title != null) updates.title = parsed.data.title;
  if (parsed.data.description != null) updates.description = parsed.data.description;
  if (parsed.data.thumbnailUrl !== undefined) updates.thumbnailUrl = parsed.data.thumbnailUrl ?? null;

  const [course] = await db
    .update(coursesTable)
    .set(updates)
    .where(eq(coursesTable.id, params.data.id))
    .returning();

  if (!course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }

  const [lessonCountRow] = await db
    .select({ count: count() })
    .from(lessonsTable)
    .where(eq(lessonsTable.courseId, course.id));

  const [enrollCountRow] = await db
    .select({ count: count() })
    .from(enrollmentsTable)
    .where(eq(enrollmentsTable.courseId, course.id));

  res.json({
    id: course.id,
    title: course.title,
    description: course.description,
    thumbnailUrl: course.thumbnailUrl ?? null,
    lessonCount: lessonCountRow?.count ?? 0,
    enrollmentCount: enrollCountRow?.count ?? 0,
    createdAt: course.createdAt.toISOString(),
  });
});

router.delete("/courses/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteCourseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Delete dependencies explicitly as well as relying on database cascades.
  // This also cleans courses created before the cascade migration was applied.
  const [course] = await db.transaction(async (tx) => {
    const [existingCourse] = await tx.select({ id: coursesTable.id }).from(coursesTable)
      .where(eq(coursesTable.id, params.data.id));
    if (!existingCourse) return [];

    const lessons = await tx.select({ id: lessonsTable.id }).from(lessonsTable)
      .where(eq(lessonsTable.courseId, existingCourse.id));
    const lessonIds = lessons.map((lesson) => lesson.id);

    if (lessonIds.length > 0) {
      const quizzes = await tx.select({ id: quizzesTable.id }).from(quizzesTable)
        .where(inArray(quizzesTable.lessonId, lessonIds));
      const quizIds = quizzes.map((quiz) => quiz.id);
      if (quizIds.length > 0) {
        const questions = await tx.select({ id: quizQuestionsTable.id }).from(quizQuestionsTable)
          .where(inArray(quizQuestionsTable.quizId, quizIds));
        const questionIds = questions.map((question) => question.id);
        if (questionIds.length > 0) await tx.delete(quizOptionsTable).where(inArray(quizOptionsTable.questionId, questionIds));
        await tx.delete(quizAttemptsTable).where(inArray(quizAttemptsTable.quizId, quizIds));
        await tx.delete(quizQuestionsTable).where(inArray(quizQuestionsTable.quizId, quizIds));
        await tx.delete(quizzesTable).where(inArray(quizzesTable.id, quizIds));
      }
      await tx.delete(userProgressTable).where(inArray(userProgressTable.lessonId, lessonIds));
      await tx.delete(lessonsTable).where(inArray(lessonsTable.id, lessonIds));
    }
    await tx.delete(assignmentSubmissionsTable).where(eq(assignmentSubmissionsTable.courseId, existingCourse.id));
    await tx.delete(enrollmentsTable).where(eq(enrollmentsTable.courseId, existingCourse.id));
    return tx.delete(coursesTable).where(eq(coursesTable.id, existingCourse.id)).returning();
  });

  if (!course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }

  res.sendStatus(204);
});

router.post("/courses/:id/enroll", requireAuth, async (req, res): Promise<void> => {
  const params = EnrollCourseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [course] = await db
    .select({ id: coursesTable.id })
    .from(coursesTable)
    .where(eq(coursesTable.id, params.data.id));

  if (!course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }

  await db
    .insert(enrollmentsTable)
    .values({ userId: req.userId!, courseId: course.id })
    .onConflictDoNothing();

  res.json({ message: "Enrolled successfully" });
});

export default router;
