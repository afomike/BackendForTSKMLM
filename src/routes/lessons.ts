import { Router } from "express";
import { db, lessonsTable, enrollmentsTable, userProgressTable } from "../lib/db.js";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireAdmin, optionalAuth } from "../lib/auth.js";
import {
  ListLessonsParams,
  CreateLessonParams,
  CreateLessonBody,
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
  title: string;
  contentType: string;
  fileUrl: string;
  description?: string;
  duration?: number | null;
};

function cleanLessonParts(parts: Partial<LessonPart>[] | undefined): LessonPart[] {
  return (parts ?? [])
    .map((part) => ({
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
    .orderBy(lessonsTable.lessonOrder);

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
      parts: serializeLessonParts(lesson.parts, {
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

  const [lesson] = await db
    .insert(lessonsTable)
    .values({
      courseId: params.data.courseId,
      title: parsed.data.title,
      lessonOrder: parsed.data.lessonOrder,
      contentType: firstPart?.contentType ?? parsed.data.contentType ?? "video",
      fileUrl: firstPart?.fileUrl ?? parsed.data.fileUrl ?? "",
      parts,
      duration: firstPart?.duration ?? parsed.data.duration ?? null,
    })
    .returning();

  res.status(201).json({
    id: lesson!.id,
    courseId: lesson!.courseId,
    title: lesson!.title,
    lessonOrder: lesson!.lessonOrder,
    contentType: asContentType(lesson!.contentType),
    fileUrl: lesson!.fileUrl,
    parts: serializeLessonParts(lesson!.parts, {
      title: lesson!.title,
      contentType: asContentType(lesson!.contentType),
      fileUrl: lesson!.fileUrl,
      duration: lesson!.duration,
    }),
    duration: lesson!.duration ?? null,
    createdAt: lesson!.createdAt.toISOString(),
  });
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

  res.json({
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
    parts: serializeLessonParts(lesson.parts, {
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
