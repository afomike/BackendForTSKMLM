import { Router } from "express";
import { db, coursesTable, lessonsTable, enrollmentsTable, userProgressTable } from "../lib/db.js";
import { eq, count, and, ilike } from "drizzle-orm";
import { requireAuth, requireAdmin, optionalAuth } from "../lib/auth.js";
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
  title: string;
  contentType: string;
  fileUrl: string;
  description?: string;
  duration?: number | null;
};

function serializeLessonParts(
  parts: unknown,
  fallback?: { title: string; contentType: "video" | "audio" | "pdf"; fileUrl: string; duration?: number | null },
): LessonPart[] {
  const serialized = Array.isArray(parts)
    ? (parts as Partial<LessonPart>[])
        .map((part, index) => ({
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

  const baseQuery = db
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

  let courses;
  if (search) {
    courses = await db
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
  } else {
    courses = await baseQuery;
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
    const prevCompleted = index === 0 || completedLessonIds.has(lessons[index - 1]!.id);
    const isLocked = isEnrolled ? !prevCompleted && index !== 0 : index !== 0;
    const progressRow = isCompleted
      ? { completedAt: null } // we'd need to fetch this separately
      : null;

    return {
      id: lesson.id,
      courseId: lesson.courseId,
      title: lesson.title,
      lessonOrder: lesson.lessonOrder,
      contentType: asContentType(lesson.contentType),
      fileUrl: lesson.fileUrl,
      parts: serializeLessonParts(lesson.parts, {
        title: lesson.title,
        contentType: asContentType(lesson.contentType),
        fileUrl: lesson.fileUrl,
        duration: lesson.duration,
      }),
      duration: lesson.duration ?? null,
      createdAt: lesson.createdAt.toISOString(),
      isCompleted,
      isLocked: isEnrolled ? (!prevCompleted && index !== 0) : (index !== 0),
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

  const [course] = await db
    .delete(coursesTable)
    .where(eq(coursesTable.id, params.data.id))
    .returning();

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
