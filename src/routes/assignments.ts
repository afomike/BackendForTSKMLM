import { Router } from "express";
import { db, coursesTable, lessonsTable, enrollmentsTable, userProgressTable, assignmentSubmissionsTable, usersTable } from "../lib/db.js";
import { eq, and, count } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../lib/auth.js";
import { GetCourseParams } from "../lib/api-zod.js";

const router = Router();

function validateAssignmentBody(body: unknown): { submissionUrl: string } | null {
  if (!body || typeof body !== "object") return null;
  const submissionUrl = (body as Record<string, unknown>).submissionUrl;
  if (typeof submissionUrl !== "string" || !submissionUrl.trim()) return null;
  return { submissionUrl: submissionUrl.trim() };
}

function validateAssignmentStatus(body: unknown): { status: "approved" | "rejected" } | null {
  if (!body || typeof body !== "object") return null;
  const status = (body as Record<string, unknown>).status;
  if (status !== "approved" && status !== "rejected") return null;
  return { status };
}

async function ensureCourseCompletion(userId: string, courseId: string) {
  const lessons = await db
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(eq(lessonsTable.courseId, courseId));

  if (lessons.length === 0) return false;

  const progressRows = await db
    .select({ lessonId: userProgressTable.lessonId })
    .from(userProgressTable)
    .where(
      and(
        eq(userProgressTable.userId, userId),
        eq(userProgressTable.completed, true),
      )
    );

  const completedLessonIds = new Set(progressRows.map((r) => r.lessonId));
  return lessons.every((lesson) => completedLessonIds.has(lesson.id));
}

router.get("/courses/:courseId/assignment", requireAuth, async (req, res): Promise<void> => {
  const params = GetCourseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { courseId } = params.data;

  const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, courseId));
  if (!course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }

  const [enrollment] = await db
    .select()
    .from(enrollmentsTable)
    .where(
      and(
        eq(enrollmentsTable.userId, req.userId!),
        eq(enrollmentsTable.courseId, courseId),
      )
    );

  if (!enrollment) {
    res.status(403).json({ error: "Not enrolled in this course" });
    return;
  }

  const completed = await ensureCourseCompletion(req.userId!, courseId);
  if (!completed) {
    res.status(403).json({ error: "Complete all lessons before submitting assignment." });
    return;
  }

  const [submission] = await db
    .select()
    .from(assignmentSubmissionsTable)
    .where(
      and(
        eq(assignmentSubmissionsTable.userId, req.userId!),
        eq(assignmentSubmissionsTable.courseId, courseId),
      )
    );

  if (!submission) {
    res.json({ hasSubmission: false });
    return;
  }

  res.json({
    hasSubmission: true,
    id: submission.id,
    submissionUrl: submission.submissionUrl,
    status: submission.status,
    reviewerId: submission.reviewerId,
    reviewedAt: submission.reviewedAt?.toISOString() ?? null,
    createdAt: submission.createdAt.toISOString(),
    updatedAt: submission.updatedAt.toISOString(),
  });
});

router.post("/courses/:courseId/assignment", requireAuth, async (req, res): Promise<void> => {
  const params = GetCourseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const requestBody = validateAssignmentBody(req.body);
  if (!requestBody) {
    res.status(400).json({ error: "Invalid assignment submission. Provide a submissionUrl." });
    return;
  }

  const { courseId } = params.data;
  const { submissionUrl } = requestBody;

  const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, courseId));
  if (!course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }

  const [enrollment] = await db
    .select()
    .from(enrollmentsTable)
    .where(
      and(
        eq(enrollmentsTable.userId, req.userId!),
        eq(enrollmentsTable.courseId, courseId),
      )
    );

  if (!enrollment) {
    res.status(403).json({ error: "Not enrolled in this course" });
    return;
  }

  const completed = await ensureCourseCompletion(req.userId!, courseId);
  if (!completed) {
    res.status(403).json({ error: "Complete all lessons before submitting assignment." });
    return;
  }

  const [existing] = await db
    .select()
    .from(assignmentSubmissionsTable)
    .where(
      and(
        eq(assignmentSubmissionsTable.userId, req.userId!),
        eq(assignmentSubmissionsTable.courseId, courseId),
      )
    );

  if (existing?.status === "approved") {
    res.status(400).json({ error: "Assignment already approved. No further changes are allowed." });
    return;
  }

  if (existing) {
    await db
      .update(assignmentSubmissionsTable)
      .set({
        submissionUrl,
        status: "pending",
        reviewerId: null,
        reviewedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(assignmentSubmissionsTable.id, existing.id));

    res.json({ message: "Assignment resubmitted and is pending review." });
    return;
  }

  await db.insert(assignmentSubmissionsTable).values({
    userId: req.userId!,
    courseId,
    submissionUrl,
    status: "pending",
  });

  res.status(201).json({ message: "Assignment submitted and is pending review." });
});

router.get("/admin/assignments", requireAdmin, async (_req, res): Promise<void> => {
  const submissions = await db.select().from(assignmentSubmissionsTable).orderBy(assignmentSubmissionsTable.createdAt.desc());

  const userIds = Array.from(new Set(submissions.map((submission) => submission.userId)));
  const courseIds = Array.from(new Set(submissions.map((submission) => submission.courseId)));

  const users = await db.select().from(usersTable).where((usersTable) => usersTable.id.in(userIds));
  const courses = await db.select().from(coursesTable).where((coursesTable) => coursesTable.id.in(courseIds));

  const userMap = new Map(users.map((user) => [user.id, user]));
  const courseMap = new Map(courses.map((course) => [course.id, course]));

  res.json(
    submissions.map((submission) => ({
      id: submission.id,
      userId: submission.userId,
      userName: userMap.get(submission.userId)?.fullname ?? "Unknown",
      userEmail: userMap.get(submission.userId)?.email ?? "",
      courseId: submission.courseId,
      courseTitle: courseMap.get(submission.courseId)?.title ?? "Unknown",
      submissionUrl: submission.submissionUrl,
      status: submission.status,
      reviewerId: submission.reviewerId,
      reviewedAt: submission.reviewedAt?.toISOString() ?? null,
      createdAt: submission.createdAt.toISOString(),
      updatedAt: submission.updatedAt.toISOString(),
    }))
  );
});

router.patch("/admin/assignments/:id/status", requireAdmin, async (req, res): Promise<void> => {
  const submissionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = validateAssignmentStatus(req.body);
  if (!submissionId || !parsed) {
    res.status(400).json({ error: "Invalid request. Provide a valid assignment id and status." });
    return;
  }

  const [submission] = await db
    .select()
    .from(assignmentSubmissionsTable)
    .where(eq(assignmentSubmissionsTable.id, submissionId));

  if (!submission) {
    res.status(404).json({ error: "Assignment submission not found" });
    return;
  }

  await db
    .update(assignmentSubmissionsTable)
    .set({
      status: parsed.status,
      reviewerId: req.userId!,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(assignmentSubmissionsTable.id, submissionId));

  res.json({ message: `Assignment ${parsed.status}.` });
});

export default router;
