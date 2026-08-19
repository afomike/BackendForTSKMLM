import { Router } from "express";
import { randomUUID } from "node:crypto";
import { db, lessonsTable, enrollmentsTable, userProgressTable } from "../lib/db.js";
import { eq, and, asc, gte, sql } from "drizzle-orm";
import { requireAuth, requireAdmin, optionalAuth } from "../lib/auth.js";
import {
  ListLessonsParams,
  CreateLessonParams,
  CreateLessonBody,
  ReorderLessonsParams,
  ReorderLessonsBody,
  GetLessonParams,
  UpdateLessonParams,
  UpdateLessonBody,
  DeleteLessonParams,
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

function cleanLessonParts(parts: Partial<LessonPart>[] | undefined): LessonPart[] {
  return (parts ?? [])
    .map((part) => ({
      partId: part.partId ?? randomUUID(),
      title: part.title.trim(),
      contentType: part.contentType,
      fileUrl: part.fileUrl.trim(),
      description: part.description?.trim() || undefined,
      duration: part.duration ?? null,
    }))
    .filter((part) => part.title.length > 0 && part.fileUrl.length > 0);
}

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

router.get("/courses/:courseId/lessons", optionalAuth, async (req, res): Promise<void> => {
  const params = ListLessonsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { courseId } = params.data;

  const lessons = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.courseId, courseId))
    .orderBy(asc(lessonsTable.lessonOrder));

  let completedLessonIds = new Set<string>();
  let completedAtMap = new Map<string, string | null>();
  let isEnrolled = false;

  if (req.userId) {
    const [enrollment] = await db
      .select()
      .from(enrollmentsTable)
      .where(
        and(
          eq(enrollmentsTable.userId, req.userId),
          eq(enrollmentsTable.courseId, courseId)
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
      for (const p of progressRows) {
        completedLessonIds.add(p.lessonId);
        completedAtMap.set(p.lessonId, p.completedAt?.toISOString() ?? null);
      }
    }
  }

  const lessonsWithProgress = lessons.map((lesson, index) => {
    const isCompleted = completedLessonIds.has(lesson.id);
    const prevCompleted = index === 0 || completedLessonIds.has(lessons[index - 1]!.id);
    const isLocked = isEnrolled ? (!prevCompleted && index !== 0) : (index !== 0);

    return {
      id: lesson.id,
      courseId: lesson.courseId,
      title: lesson.title,
      lessonOrder: lesson.lessonOrder,
      contentType: asContentType(lesson.contentType),
      fileUrl: lesson.fileUrl,
      parts: serializeLessonParts(lesson.parts, lesson.id, {
        title: lesson.title,
        contentType: asContentType(lesson.contentType),
        fileUrl: lesson.fileUrl,
        duration: lesson.duration,
      }),
      duration: lesson.duration ?? null,
      createdAt: lesson.createdAt.toISOString(),
      isCompleted,
      isLocked,
      completedAt: completedAtMap.get(lesson.id) ?? null,
    };
  });

  res.json(lessonsWithProgress);
});

router.post("/courses/:courseId/lessons", requireAdmin, async (req, res): Promise<void> => {
  const params = CreateLessonParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = CreateLessonBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const parts = cleanLessonParts(parsed.data.parts);
  if (parts.length === 0) {
    res.status(400).json({ error: "At least one lesson part with a title and content file is required" });
    return;
  }

  const firstPart = parts[0];

  const [lesson] = await db.transaction(async (tx) => {
    const insertOrder = Math.max(1, Math.floor(parsed.data.lessonOrder));
    await tx
      .update(lessonsTable)
      .set({ lessonOrder: sql`${lessonsTable.lessonOrder} + 1000000` })
      .where(and(eq(lessonsTable.courseId, params.data.courseId), gte(lessonsTable.lessonOrder, insertOrder)));

    const [created] = await tx
      .insert(lessonsTable)
      .values({
        courseId: params.data.courseId,
        title: parsed.data.title,
        lessonOrder: insertOrder,
        contentType: firstPart?.contentType ?? parsed.data.contentType ?? "video",
        fileUrl: firstPart?.fileUrl ?? parsed.data.fileUrl ?? "",
        parts,
        duration: firstPart?.duration ?? parsed.data.duration ?? null,
      })
      .returning();

    await tx
      .update(lessonsTable)
      .set({ lessonOrder: sql`${lessonsTable.lessonOrder} - 999999` })
      .where(and(eq(lessonsTable.courseId, params.data.courseId), gte(lessonsTable.lessonOrder, insertOrder + 1000000)));
    return [created];
  });

  res.status(201).json({
    id: lesson!.id,
    courseId: lesson!.courseId,
    title: lesson!.title,
    lessonOrder: lesson!.lessonOrder,
    contentType: asContentType(lesson!.contentType),
    fileUrl: lesson!.fileUrl,
    parts: serializeLessonParts(lesson!.parts, lesson!.id, {
      title: lesson!.title,
      contentType: asContentType(lesson!.contentType),
      fileUrl: lesson!.fileUrl,
      duration: lesson!.duration,
    }),
    duration: lesson!.duration ?? null,
    createdAt: lesson!.createdAt.toISOString(),
  });
});

router.patch("/courses/:courseId/lessons/reorder", requireAdmin, async (req, res): Promise<void> => {
  const params = ReorderLessonsParams.safeParse(req.params);
  const parsed = ReorderLessonsBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "A course id and ordered lesson ids are required" });
    return;
  }

  const lessons = await db
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(eq(lessonsTable.courseId, params.data.courseId));
  const existingIds = new Set(lessons.map((lesson) => lesson.id));
  const lessonIds = parsed.data.lessonIds;
  if (lessonIds.length !== existingIds.size || new Set(lessonIds).size !== lessonIds.length || lessonIds.some((id) => !existingIds.has(id))) {
    res.status(400).json({ error: "The ordered lesson list must contain every lesson exactly once" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(lessonsTable)
      .set({ lessonOrder: sql`${lessonsTable.lessonOrder} + 1000000` })
      .where(eq(lessonsTable.courseId, params.data.courseId));

    for (const [index, lessonId] of lessonIds.entries()) {
      await tx
        .update(lessonsTable)
        .set({ lessonOrder: index + 1 })
        .where(and(eq(lessonsTable.id, lessonId), eq(lessonsTable.courseId, params.data.courseId)));
    }
  });

  res.json({ lessonIds });
});

router.get("/lessons/:id", optionalAuth, async (req, res): Promise<void> => {
  const params = GetLessonParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, params.data.id));

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  let completedPartIds: string[] = [];
  if (req.userId) {
    const [progress] = await db
      .select({ completedParts: userProgressTable.completedParts })
      .from(userProgressTable)
      .where(and(eq(userProgressTable.userId, req.userId), eq(userProgressTable.lessonId, lesson.id)));
    completedPartIds = progress?.completedParts ?? [];
  }

  res.json({
    id: lesson.id,
    courseId: lesson.courseId,
    title: lesson.title,
    lessonOrder: lesson.lessonOrder,
    contentType: asContentType(lesson.contentType),
    fileUrl: lesson.fileUrl,
    parts: serializeLessonParts(lesson.parts, lesson.id, {
      title: lesson.title,
      contentType: asContentType(lesson.contentType),
      fileUrl: lesson.fileUrl,
      duration: lesson.duration,
    }),
    duration: lesson.duration ?? null,
    completedPartIds,
    createdAt: lesson.createdAt.toISOString(),
  });
});

router.patch("/lessons/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateLessonParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateLessonBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.title != null) updates.title = parsed.data.title;
  if (parsed.data.lessonOrder != null) updates.lessonOrder = parsed.data.lessonOrder;
  if (parsed.data.contentType != null) updates.contentType = parsed.data.contentType;
  if (parsed.data.fileUrl != null) updates.fileUrl = parsed.data.fileUrl;
  if (parsed.data.parts !== undefined) {
    const parts = cleanLessonParts(parsed.data.parts);
    if (parts.length === 0) {
      res.status(400).json({ error: "At least one lesson part with a title and content file is required" });
      return;
    }

    const firstPart = parts[0];
    updates.parts = parts;
    if (firstPart) {
      updates.contentType = firstPart.contentType;
      updates.fileUrl = firstPart.fileUrl;
      updates.duration = firstPart.duration ?? null;
    }
  }
  if (parsed.data.duration !== undefined) updates.duration = parsed.data.duration ?? null;

  const [lesson] = await db
    .update(lessonsTable)
    .set(updates)
    .where(eq(lessonsTable.id, params.data.id))
    .returning();

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  res.json({
    id: lesson.id,
    courseId: lesson.courseId,
    title: lesson.title,
    lessonOrder: lesson.lessonOrder,
    contentType: asContentType(lesson.contentType),
    fileUrl: lesson.fileUrl,
    parts: serializeLessonParts(lesson.parts, lesson.id, {
      title: lesson.title,
      contentType: asContentType(lesson.contentType),
      fileUrl: lesson.fileUrl,
      duration: lesson.duration,
    }),
    duration: lesson.duration ?? null,
    createdAt: lesson.createdAt.toISOString(),
  });
});

router.delete("/lessons/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteLessonParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [lesson] = await db
    .delete(lessonsTable)
    .where(eq(lessonsTable.id, params.data.id))
    .returning();

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
