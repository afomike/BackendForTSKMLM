import { Router } from "express";
import { Readable } from "node:stream";
import { db, userProgressTable, lessonsTable, enrollmentsTable, coursesTable, quizzesTable, quizAttemptsTable, assignmentSubmissionsTable } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import {
  GetCourseProgressParams,
  GetCertificateParams,
} from "../lib/api-zod.js";

const router = Router();

type DownloadPart = {
  partId?: string;
  title?: string;
  fileUrl?: string;
  downloadable?: boolean;
};

function isYouTubeUrl(fileUrl: string): boolean {
  try {
    const host = new URL(fileUrl).hostname.toLowerCase().replace(/^www\./, "");
    return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
  } catch {
    return false;
  }
}

function canDownload(part: DownloadPart): boolean {
  // YouTube URLs are deliberately streaming-only, even if old data says
  // otherwise. This avoids attempting to download content the platform hosts.
  return Boolean(part.fileUrl) && !isYouTubeUrl(part.fileUrl!) && part.downloadable !== false;
}

function lessonParts(lesson: typeof lessonsTable.$inferSelect): Required<Pick<DownloadPart, "partId" | "title" | "fileUrl">>[] & DownloadPart[] {
  const saved = Array.isArray(lesson.parts) ? lesson.parts as DownloadPart[] : [];
  const parts = saved.length > 0 ? saved : [{ title: lesson.title, fileUrl: lesson.fileUrl, downloadable: undefined }];
  return parts
    .filter((part) => typeof part.fileUrl === "string" && part.fileUrl.trim().length > 0)
    .map((part, index) => ({
      ...part,
      partId: part.partId ?? `legacy-${lesson.id}-${index}`,
      title: part.title?.trim() || `Part ${index + 1}`,
      fileUrl: part.fileUrl!.trim(),
    }));
}

async function requireEnrollment(userId: string, lesson: typeof lessonsTable.$inferSelect): Promise<boolean> {
  const [enrollment] = await db.select({ id: enrollmentsTable.id }).from(enrollmentsTable).where(
    and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, lesson.courseId)),
  );
  return Boolean(enrollment);
}

function safeDownloadFilename(title: string, contentType: string | null): string {
  const name = title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "lesson-download";
  const extension = contentType?.includes("pdf") ? ".pdf" : contentType?.startsWith("audio/") ? ".mp3" : contentType?.startsWith("video/") ? ".mp4" : "";
  return `${name.slice(0, 120)}${extension}`;
}

// Lists every downloadable part in a course. The client can use each URL to
// download items one-by-one; YouTube parts are returned with an explanation.
router.get("/courses/:courseId/downloads", requireAuth, async (req, res): Promise<void> => {
  const courseId = Array.isArray(req.params.courseId) ? req.params.courseId[0] : req.params.courseId;
  if (!courseId) {
    res.status(400).json({ error: "Course id is required" });
    return;
  }
  const lessons = await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, courseId));
  if (lessons.length === 0) {
    res.status(404).json({ error: "Course has no lessons" });
    return;
  }
  if (!(await requireEnrollment(req.userId!, lessons[0]!))) {
    res.status(403).json({ error: "Not enrolled in this course" });
    return;
  }
  const progress = await db.select({ lessonId: userProgressTable.lessonId, downloadedParts: userProgressTable.downloadedParts })
    .from(userProgressTable).where(eq(userProgressTable.userId, req.userId!));
  const downloadedByLesson = new Map(progress.map((row) => [row.lessonId, row.downloadedParts ?? []]));
  const items = lessons.flatMap((lesson) => lessonParts(lesson).map((part) => ({
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    partId: part.partId,
    partTitle: part.title,
    isDownloadable: canDownload(part),
    isDownloaded: (downloadedByLesson.get(lesson.id) ?? []).includes(part.partId),
    unavailableReason: canDownload(part) ? null : "This part is hosted on YouTube and is available for streaming only.",
    downloadUrl: canDownload(part) ? `/api/lessons/${lesson.id}/parts/${part.partId}/download` : null,
  })));
  res.json({ courseId, downloadableCount: items.filter((item) => item.isDownloadable).length, items });
});

// Streams one hosted file as an attachment. A part is marked downloaded/read
// only after the remote host accepts the download request. It never completes
// the lesson, so a required quiz remains compulsory.
router.get("/lessons/:id/parts/:partId/download", requireAuth, async (req, res): Promise<void> => {
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
  if (!(await requireEnrollment(req.userId!, lesson))) {
    res.status(403).json({ error: "Not enrolled in this course" });
    return;
  }
  const part = lessonParts(lesson).find((item) => item.partId === partId);
  if (!part) {
    res.status(404).json({ error: "Lesson part not found" });
    return;
  }
  if (!canDownload(part)) {
    res.status(422).json({ error: "This part is hosted on YouTube and is available for streaming only.", code: "STREAMING_ONLY" });
    return;
  }
  let source: URL;
  try {
    source = new URL(part.fileUrl!, `${req.protocol}://${req.get("host")}`);
  } catch {
    res.status(422).json({ error: "This lesson part does not have a valid download URL" });
    return;
  }
  let upstream: Response;
  try {
    upstream = await fetch(source);
  } catch {
    res.status(502).json({ error: "The lesson file could not be reached right now" });
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.status(502).json({ error: "The lesson file could not be downloaded right now" });
    return;
  }
  const [existing] = await db.select().from(userProgressTable).where(
    and(eq(userProgressTable.userId, req.userId!), eq(userProgressTable.lessonId, lessonId)),
  );
  const downloadedParts = Array.from(new Set([...(existing?.downloadedParts ?? []), partId]));
  const completedParts = Array.from(new Set([...(existing?.completedParts ?? []), partId]));
  await db.insert(userProgressTable).values({ userId: req.userId!, lessonId, downloadedParts, completedParts })
    .onConflictDoUpdate({ target: [userProgressTable.userId, userProgressTable.lessonId], set: { downloadedParts, completedParts } });
  const contentType = upstream.headers.get("content-type");
  if (contentType) res.setHeader("Content-Type", contentType);
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeDownloadFilename(part.title!, contentType))}`);
  Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>).pipe(res);
});

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
