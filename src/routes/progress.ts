import { Router } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetchDownload, validateDownloadUrl } from "../lib/download-source.js";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { lessonAccess } from "../lib/lesson-access.js";
import { withLessonRevision } from "../lib/course-revision.js";
import { SavePlaybackBody, mergePlayback } from "../lib/playback.js";
import { db, userProgressTable, lessonsTable, enrollmentsTable, coursesTable, quizzesTable, quizAttemptsTable, assignmentSubmissionsTable } from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import {
  GetCourseProgressParams,
  GetCertificateParams,
} from "../lib/api-zod.js";

const router = Router();

router.patch("/lessons/:id/parts/:partId/playback", requireAuth, async (req, res): Promise<void> => {
  const parsed = SavePlaybackBody.safeParse(req.body);
  const lessonId = typeof req.params.id === "string" ? req.params.id : "";
  const partId = typeof req.params.partId === "string" ? req.params.partId : "";
  if (!parsed.success || !lessonId || !partId) { res.status(400).json({ error: "Provide a valid playback position, duration and lesson revision" }); return; }
  if (Date.parse(parsed.data.capturedAt) > Date.now() + 5 * 60_000) { res.status(400).json({ error: "Your device clock is ahead. Correct it before saving progress." }); return; }
  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId));
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }
  if (!(await requireEnrollment(req.userId!, lesson))) { res.status(403).json({ error: "Not enrolled in this course" }); return; }
  if (!(await lessonAccess(lesson.courseId, req.userId, req.userRole)).has(lesson.id)) { res.status(403).json({ error: "Complete the previous lesson first" }); return; }
  const part = lessonParts(lesson).find(part => part.partId === partId);
  if (!part || !["video", "audio"].includes(part.contentType ?? lesson.contentType)) { res.status(400).json({ error: "Playback can only be saved for a video or audio part in this lesson" }); return; }
  const saved = await withLessonRevision(lesson, parsed.data.lessonUpdatedAt, async tx => {
    const [existing] = await tx.select().from(userProgressTable)
      .where(and(eq(userProgressTable.userId, req.userId!), eq(userProgressTable.lessonId, lessonId)));
    const playbackPositions = mergePlayback(existing?.playbackPositions ?? {}, partId, {
      positionSeconds: parsed.data.positionSeconds, durationSeconds: parsed.data.durationSeconds, capturedAt: parsed.data.capturedAt,
    });
    const lastViewedAt = new Date();
    await tx.insert(userProgressTable).values({ userId: req.userId!, lessonId, playbackPositions, lastViewedAt })
      .onConflictDoUpdate({ target: [userProgressTable.userId, userProgressTable.lessonId], set: { playbackPositions, lastViewedAt } });
  });
  if (!saved) { res.status(409).json({ error: "Lesson content changed. Refresh before saving progress." }); return; }
  res.json({ message: "Playback saved" });
});

type DownloadPart = {
  partId?: string;
  title?: string;
  fileUrl?: string;
  downloadable?: boolean;
  contentType?: string;
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

function lessonParts(lesson: typeof lessonsTable.$inferSelect): Array<DownloadPart & { partId: string; title: string; fileUrl: string }> {
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
  return `${name.slice(0, 120)}${extension && !name.toLowerCase().endsWith(extension) ? extension : ""}`;
}

function sourceFilename(title: string, source: URL, contentType: string | null, declaredType?: string): string {
  let urlName = source.pathname.split("/").pop() ?? "";
  try { urlName = decodeURIComponent(urlName); } catch { /* Keep malformed escapes as literal filename text. */ }
  const declaredContentType = declaredType === "pdf" ? "application/pdf" : declaredType === "audio" ? "audio/mpeg" : declaredType === "video" ? "video/mp4" : contentType;
  const extension = urlName.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? safeDownloadFilename("file", declaredContentType).replace("file", "");
  const base = title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "download";
  return `${base.slice(0, 120)}${extension && !base.toLowerCase().endsWith(extension.toLowerCase()) ? extension : ""}`;
}

function archiveName(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Untitled";
}

function crc32(bytes: Uint8Array, current = 0): number {
  let crc = current ^ -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function zipLocalHeader(name: Buffer): Buffer {
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0808, 6);
  header.writeUInt16LE(0, 8); header.writeUInt16LE(0, 10); header.writeUInt16LE(0, 12);
  header.writeUInt32LE(0, 14); header.writeUInt32LE(0, 18); header.writeUInt32LE(0, 22);
  header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28); name.copy(header, 30);
  return header;
}

type ZipEntry = { name: Buffer; offset: number; crc: number; size: number };
function zipCentralHeader(entry: ZipEntry): Buffer {
  const header = Buffer.alloc(46 + entry.name.length);
  header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0808, 8); header.writeUInt16LE(0, 10); header.writeUInt16LE(0, 12); header.writeUInt16LE(0, 14);
  header.writeUInt32LE(entry.crc, 16); header.writeUInt32LE(entry.size, 20); header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28); header.writeUInt16LE(0, 30); header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34); header.writeUInt16LE(0, 36); header.writeUInt32LE(0, 38); header.writeUInt32LE(entry.offset, 42);
  entry.name.copy(header, 46); return header;
}

async function writeResponse(res: import("express").Response, data: Uint8Array): Promise<void> {
  if (res.destroyed) throw new Error("Download connection closed");
  await new Promise<void>((resolve, reject) => res.write(data, error => error ? reject(error) : resolve()));
}

async function markDownloaded(userId: string, lesson: typeof lessonsTable.$inferSelect, partIds: string[]): Promise<void> {
  await withLessonRevision(lesson, undefined, async tx => {
    const lessonId = lesson.id;
    const [existing] = await tx.select().from(userProgressTable).where(and(eq(userProgressTable.userId, userId), eq(userProgressTable.lessonId, lessonId)));
    const downloadedParts = Array.from(new Set([...(existing?.downloadedParts ?? []), ...partIds]));
    const completedParts = Array.from(new Set([...(existing?.completedParts ?? []), ...partIds]));
    await tx.insert(userProgressTable).values({ userId, lessonId, downloadedParts, completedParts })
      .onConflictDoUpdate({ target: [userProgressTable.userId, userProgressTable.lessonId], set: { downloadedParts, completedParts } });
  });
}

async function resolveSource(rawUrl: string, req: import("express").Request): Promise<URL | null> {
  try {
    const storagePath = rawUrl.startsWith("/objects/")
      ? (await new ObjectStorageService().getObjectEntityFile(rawUrl)).url
      : rawUrl;
    const source = validateDownloadUrl(storagePath);

    if (source.hostname === "drive.google.com") {
      const fileId = source.pathname.match(/^\/file\/d\/([^/]+)/)?.[1] ?? source.searchParams.get("id");
      if (fileId) {
        return new URL(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download`);
      }
    }

    return source;
  } catch {
    return null;
  }
}

async function streamZip(
  req: import("express").Request,
  res: import("express").Response,
  files: Array<{ lessonId: string; path: string; part: DownloadPart }>,
): Promise<Map<string, string[]>> {
  if (files.length > 100) throw Object.assign(new Error("Download up to 100 files per archive. Download lessons separately."), { status: 422 });
  const sources: Array<{
    file: (typeof files)[number];
    response: Response;
  }> = [];
  const archivePaths = new Set<string>();

  try {
    for (const file of files) {
      const source = file.part.fileUrl ? await resolveSource(file.part.fileUrl, req) : null;
      if (!source) throw Object.assign(new Error(`Download URL is invalid or its host is not allowed for ${file.part.title ?? "lesson part"}`), { status: 422 });
      let upstream: Response;
      try {
        upstream = await fetchDownload(source);
      } catch {
        throw Object.assign(new Error(`Could not reach the file for ${file.part.title ?? "lesson part"}`), { status: 502 });
      }
      if (!upstream.ok || !upstream.body || upstream.headers.get("content-type")?.toLowerCase().includes("text/html")) {
        await upstream.body?.cancel();
        throw Object.assign(new Error(`Could not download the file for ${file.part.title ?? "lesson part"}`), { status: 502 });
      }
      sources.push({ file, response: upstream });
    }

    if (sources.length === 0) {
      throw new Error("No downloadable files were found");
    }

    const entries: ZipEntry[] = []; const downloaded = new Map<string, string[]>(); let offset = 0;
    res.status(200).setHeader("Content-Type", "application/zip");
    for (const { file, response: upstream } of sources) {
      let path = file.path;
      const extension = path.match(/\.[^/.]+$/)?.[0] ?? "";
      const base = extension ? path.slice(0, -extension.length) : path;
      for (let duplicate = 2; archivePaths.has(path.toLowerCase()); duplicate++) path = `${base} (${duplicate})${extension}`;
      archivePaths.add(path.toLowerCase());
      const name = Buffer.from(path, "utf8"); const entry: ZipEntry = { name, offset, crc: 0, size: 0 };
      const local = zipLocalHeader(name); await writeResponse(res, local); offset += local.length;
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          const chunk = Buffer.from(value);
          if (offset + chunk.length > 1024 * 1024 * 1024) throw new Error("Archive exceeds the 1 GB limit");
          entry.crc = crc32(chunk, entry.crc); entry.size += chunk.length;
          await writeResponse(res, chunk); offset += chunk.length;
        }
      } finally { reader.releaseLock(); }
      const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(entry.crc, 4);
      descriptor.writeUInt32LE(entry.size, 8); descriptor.writeUInt32LE(entry.size, 12); await writeResponse(res, descriptor); offset += descriptor.length;
      if (file.part.partId) downloaded.set(file.lessonId, [...(downloaded.get(file.lessonId) ?? []), file.part.partId]);
      entries.push(entry);
    }
    const centralOffset = offset;
    for (const entry of entries) { const central = zipCentralHeader(entry); await writeResponse(res, central); offset += central.length; }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12); end.writeUInt32LE(centralOffset, 16); await writeResponse(res, end); res.end();
    return downloaded;
  } finally {
    await Promise.all(sources.map(({ response }) => response.body?.cancel().catch(() => {})));
  }
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
  const accessible = await lessonAccess(courseId, req.userId, req.userRole);
  const items = lessons.filter(lesson => accessible.has(lesson.id)).flatMap((lesson) => lessonParts(lesson).map((part) => ({
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

router.get("/courses/:courseId/download", requireAuth, async (req, res): Promise<void> => {
  const courseId = Array.isArray(req.params.courseId) ? req.params.courseId[0] : req.params.courseId;
  if (!courseId) { res.status(400).json({ error: "Course id is required" }); return; }
  const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, courseId));
  if (!course) { res.status(404).json({ error: "Course not found" }); return; }
  const lessons = await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, courseId)).orderBy(lessonsTable.lessonOrder);
  if (lessons.length === 0 || !(await requireEnrollment(req.userId!, lessons[0]!))) { res.status(lessons.length ? 403 : 404).json({ error: lessons.length ? "Not enrolled in this course" : "Course has no lessons" }); return; }
  const accessible = await lessonAccess(courseId, req.userId, req.userRole);
  const files = lessons.filter(lesson => accessible.has(lesson.id)).flatMap((lesson, lessonIndex) => lessonParts(lesson).filter(canDownload).map((part, partIndex) => {
    const source = new URL(part.fileUrl, `${req.protocol}://${req.get("host")}`);
    const contentType = part.contentType === "pdf" ? "application/pdf" : part.contentType === "audio" ? "audio/mpeg" : part.contentType === "video" ? "video/mp4" : null;
    return { lessonId: lesson.id, part, path: `${archiveName(lesson.title)}/${sourceFilename(part.title, source, contentType, part.contentType)}` };
  }));
  if (files.length === 0) { res.status(422).json({ error: "This course has no downloadable files" }); return; }
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${archiveName(course.title)}.zip`)}`);
  const downloaded = await streamZip(req, res, files);
  await Promise.all([...downloaded.entries()].map(([lessonId, partIds]) => markDownloaded(req.userId!, lessons.find(lesson => lesson.id === lessonId)!, partIds)));
});

router.get("/lessons/:id/download", requireAuth, async (req, res): Promise<void> => {
  const lessonId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!lessonId) { res.status(400).json({ error: "Lesson id is required" }); return; }
  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId));
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }
  if (!(await requireEnrollment(req.userId!, lesson))) { res.status(403).json({ error: "Not enrolled in this course" }); return; }
  if (!(await lessonAccess(lesson.courseId, req.userId, req.userRole)).has(lesson.id)) {
    res.status(403).json({ error: "Complete the previous lesson to unlock this lesson" }); return;
  }
  const files = lessonParts(lesson).filter(canDownload).map((part, partIndex) => {
    const source = new URL(part.fileUrl, `${req.protocol}://${req.get("host")}`);
    const contentType = part.contentType === "pdf" ? "application/pdf" : part.contentType === "audio" ? "audio/mpeg" : part.contentType === "video" ? "video/mp4" : null;
    return { lessonId: lesson.id, part, path: sourceFilename(part.title, source, contentType, part.contentType) };
  });
  if (files.length === 0) { res.status(422).json({ error: "This lesson has no downloadable files" }); return; }
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${archiveName(lesson.title)}.zip`)}`);
  const downloaded = await streamZip(req, res, files);
  await markDownloaded(req.userId!, lesson, downloaded.get(lesson.id) ?? []);
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
  if (!(await lessonAccess(lesson.courseId, req.userId, req.userRole)).has(lesson.id)) {
    res.status(403).json({ error: "Complete the previous lesson to unlock this lesson" }); return;
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
  const source = await resolveSource(part.fileUrl!, req);
  if (!source) {
    res.status(422).json({ error: "Download URL is invalid or its host is not allowed. Use a trusted HTTPS file host." });
    return;
  }
  let upstream: Response;
  try {
    upstream = await fetchDownload(source);
  } catch {
    res.status(502).json({ error: "The lesson file could not be reached right now" });
    return;
  }
  if (!upstream.ok || !upstream.body || upstream.headers.get("content-type")?.toLowerCase().includes("text/html")) {
    await upstream.body?.cancel();
    res.status(502).json({ error: "The lesson file could not be downloaded right now" });
    return;
  }
  const upstreamContentType = upstream.headers.get("content-type");
  const contentType = upstreamContentType?.toLowerCase().includes("application/octet-stream")
    ? part.contentType === "pdf" ? "application/pdf" : part.contentType === "audio" ? "audio/mpeg" : part.contentType === "video" ? "video/mp4" : upstreamContentType
    : upstreamContentType;
  if (contentType) res.setHeader("Content-Type", contentType);
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(sourceFilename(part.title!, source, contentType, part.contentType))}`);
  await pipeline(Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>), res);
  await markDownloaded(req.userId!, lesson, [partId]);
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

  if (!(await lessonAccess(lesson.courseId, req.userId, req.userRole)).has(lesson.id)) {
    res.status(403).json({ error: "Complete the previous lesson to unlock this lesson" }); return;
  }
  const quizPassed = await hasPassedLessonQuiz(req.userId!, lessonId);
  if (!quizPassed) {
    res.status(403).json({ error: "You must pass the lesson quiz before marking this lesson complete." });
    return;
  }

  const saved = await withLessonRevision(lesson, (req.body ?? {}).lessonUpdatedAt, async tx => {
    await tx
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

  });
  if (!saved) { res.status(409).json({ error: "This lesson was updated. Refresh it before completing it." }); return; }

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

  if (!(await lessonAccess(lesson.courseId, req.userId, req.userRole)).has(lesson.id)) {
    res.status(403).json({ error: "Complete the previous lesson to unlock this lesson" }); return;
  }
  const lessonParts = Array.isArray(lesson.parts) && lesson.parts.length > 0 ? lesson.parts as Array<{ partId?: string }> : [{}];
  const knownPartIds = lessonParts.map((part, index) => part.partId ?? `legacy-${lesson.id}-${index}`);
  if (!knownPartIds.includes(partId)) {
    res.status(400).json({ error: "Part id is not part of this lesson" });
    return;
  }

  let completedParts: string[] = [];
  const saved = await withLessonRevision(lesson, (req.body ?? {}).lessonUpdatedAt, async tx => {
    const [existing] = await tx.select().from(userProgressTable)
      .where(and(eq(userProgressTable.userId, req.userId!), eq(userProgressTable.lessonId, lessonId)));
    completedParts = Array.from(new Set([...(existing?.completedParts ?? []).filter(id => knownPartIds.includes(id)), partId]));
    await tx
      .insert(userProgressTable)
      .values({ userId: req.userId!, lessonId, completedParts })
      .onConflictDoUpdate({
        target: [userProgressTable.userId, userProgressTable.lessonId],
        set: { completedParts },
    });

  });
  if (!saved) { res.status(409).json({ error: "This lesson was updated. Refresh it before completing it." }); return; }

  res.json({ completedPartIds: completedParts, completedPartIndexes: completedParts });
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
  if (typeof completed !== "boolean") {
    res.status(400).json({ error: "completed must be a boolean" });
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

  const isCompleted = Boolean(completed);

  if (isCompleted) {
    if (!(await lessonAccess(lesson.courseId, req.userId, req.userRole)).has(lesson.id)) {
      res.status(403).json({ error: "Complete the previous lesson to unlock this lesson" }); return;
    }
    const quizPassed = await hasPassedLessonQuiz(req.userId!, lessonId);
    if (!quizPassed) {
      res.status(403).json({ error: "You must pass the lesson quiz before marking this lesson complete." });
      return;
    }
  }

  const saved = await withLessonRevision(lesson, (req.body ?? {}).lessonUpdatedAt, async tx => {
    await tx
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

  });
  if (!saved) { res.status(409).json({ error: "This lesson was updated. Refresh it before completing it." }); return; }

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

  const progressRows = await db.select().from(userProgressTable).where(eq(userProgressTable.userId, req.userId!));

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

    const completedInCourse = progressRows.filter((p) =>
      p.completed && lessons.some((l) => l.id === p.lessonId)
    );

    const totalLessons = lessons.length;
    const completedLessons = completedInCourse.length;
    const progressPercent = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
    const isCompleted = totalLessons > 0 && completedLessons === totalLessons;

    const lastActivity = progressRows.filter(p => lessons.some(l => l.id === p.lessonId))
      .sort((a, b) => Math.max(b.completedAt?.getTime() ?? 0, b.lastViewedAt?.getTime() ?? 0) - Math.max(a.completedAt?.getTime() ?? 0, a.lastViewedAt?.getTime() ?? 0))[0];

    enrolledCourses.push({
      courseId: course.id,
      courseTitle: course.title,
      thumbnailUrl: course.thumbnailUrl ?? null,
      totalLessons,
      completedLessons,
      progressPercent,
      isCompleted,
      lastActivityAt: lastActivity ? new Date(Math.max(lastActivity.completedAt?.getTime() ?? 0, lastActivity.lastViewedAt?.getTime() ?? 0)).toISOString() : null,
    });
  }

  const allProgressRows = progressRows;

  res.json({
    totalEnrolled: enrollments.length,
    totalCompleted: enrolledCourses.filter((c) => c.isCompleted).length,
    totalLessons: enrolledCourses.reduce((sum, c) => sum + c.totalLessons, 0),
    completedLessons: allProgressRows.filter(row => row.completed).length,
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

      )
    );

  const completedInCourse = progressRows.filter((p) =>
    p.completed && lessons.some((l) => l.id === p.lessonId)
  );

  const totalLessons = lessons.length;
  const completedLessons = completedInCourse.length;
  const progressPercent = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
  const isCompleted = totalLessons > 0 && completedLessons === totalLessons;

  const lastActivity = progressRows.filter(p => lessons.some(l => l.id === p.lessonId))
    .sort((a, b) => Math.max(b.completedAt?.getTime() ?? 0, b.lastViewedAt?.getTime() ?? 0) - Math.max(a.completedAt?.getTime() ?? 0, a.lastViewedAt?.getTime() ?? 0))[0];

  res.json({
    courseId: course.id,
    courseTitle: course.title,
    thumbnailUrl: course.thumbnailUrl ?? null,
    totalLessons,
    completedLessons,
    progressPercent,
    isCompleted,
    lastActivityAt: lastActivity ? new Date(Math.max(lastActivity.completedAt?.getTime() ?? 0, lastActivity.lastViewedAt?.getTime() ?? 0)).toISOString() : null,
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
