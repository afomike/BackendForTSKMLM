import { Router } from "express";
import { db, usersTable, coursesTable, lessonsTable, enrollmentsTable, userProgressTable } from "../lib/db.js";
import { eq, and, count, sql } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../lib/auth.js";

const router = Router();

router.get("/stats/admin", requireAdmin, async (_req, res): Promise<void> => {
  const [studentCount] = await db
    .select({ count: count() })
    .from(usersTable)
    .where(eq(usersTable.role, "student"));

  const [courseCount] = await db.select({ count: count() }).from(coursesTable);
  const [lessonCount] = await db.select({ count: count() }).from(lessonsTable);
  const [activeStudentCount] = await db
    .select({ count: count() })
    .from(usersTable)
    .where(and(eq(usersTable.role, "student"), eq(usersTable.status, "active")));

  // Recent enrollments (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const [recentEnrollCount] = await db
    .select({ count: count() })
    .from(enrollmentsTable)
    .where(sql`${enrollmentsTable.enrolledAt} > ${thirtyDaysAgo}`);

  // Overall completion rate
  const totalEnrollments = await db.select({ count: count() }).from(enrollmentsTable);
  const allCourses = await db.select({ id: coursesTable.id }).from(coursesTable);
  let completedCount = 0;
  for (const course of allCourses) {
    const lessons = await db
      .select({ id: lessonsTable.id })
      .from(lessonsTable)
      .where(eq(lessonsTable.courseId, course.id));
    if (lessons.length === 0) continue;

    const enrollments = await db
      .select({ userId: enrollmentsTable.userId })
      .from(enrollmentsTable)
      .where(eq(enrollmentsTable.courseId, course.id));

    for (const { userId } of enrollments) {
      const progress = await db
        .select({ count: count() })
        .from(userProgressTable)
        .where(
          and(
            eq(userProgressTable.userId, userId),
            eq(userProgressTable.completed, true)
          )
        );
      const completed = progress[0]?.count ?? 0;
      if (completed >= lessons.length) completedCount++;
    }
  }

  const totalEnroll = totalEnrollments[0]?.count ?? 1;
  const completionRate = Math.round((completedCount / Math.max(totalEnroll, 1)) * 100);

  res.json({
    totalStudents: studentCount?.count ?? 0,
    totalCourses: courseCount?.count ?? 0,
    totalLessons: lessonCount?.count ?? 0,
    overallCompletionRate: completionRate,
    activeStudents: activeStudentCount?.count ?? 0,
    recentEnrollments: recentEnrollCount?.count ?? 0,
  });
});

router.get("/stats/student", requireAuth, async (req, res): Promise<void> => {
  const enrollments = await db
    .select({ courseId: enrollmentsTable.courseId })
    .from(enrollmentsTable)
    .where(eq(enrollmentsTable.userId, req.userId!));

  const courseIds = enrollments.map((e) => e.courseId);

  let totalLessons = 0;
  let completedCourses = 0;

  for (const courseId of courseIds) {
    const lessons = await db
      .select({ id: lessonsTable.id })
      .from(lessonsTable)
      .where(eq(lessonsTable.courseId, courseId));

    totalLessons += lessons.length;

    const progress = await db
      .select({ count: count() })
      .from(userProgressTable)
      .where(
        and(
          eq(userProgressTable.userId, req.userId!),
          eq(userProgressTable.completed, true)
        )
      );

    const completedInCourse = (await db
      .select()
      .from(userProgressTable)
      .where(
        and(
          eq(userProgressTable.userId, req.userId!),
          eq(userProgressTable.completed, true)
        )
      )).filter((p) => lessons.some((l) => l.id === p.lessonId));

    if (lessons.length > 0 && completedInCourse.length === lessons.length) {
      completedCourses++;
    }
  }

  const [completedLessonsRow] = await db
    .select({ count: count() })
    .from(userProgressTable)
    .where(
      and(
        eq(userProgressTable.userId, req.userId!),
        eq(userProgressTable.completed, true)
      )
    );

  const completedLessons = completedLessonsRow?.count ?? 0;
  const remainingLessons = Math.max(0, totalLessons - completedLessons);
  const overallProgress = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

  res.json({
    totalEnrolled: enrollments.length,
    completedCourses,
    completedLessons,
    remainingLessons,
    overallProgress,
  });
});

router.get("/admin/popular-courses", requireAdmin, async (_req, res): Promise<void> => {
  const courses = await db.select().from(coursesTable).orderBy(coursesTable.createdAt);

  const withStats = await Promise.all(
    courses.map(async (course) => {
      const [enrollCount] = await db
        .select({ count: count() })
        .from(enrollmentsTable)
        .where(eq(enrollmentsTable.courseId, course.id));

      const lessons = await db
        .select({ id: lessonsTable.id })
        .from(lessonsTable)
        .where(eq(lessonsTable.courseId, course.id));

      const enrollments = await db
        .select({ userId: enrollmentsTable.userId })
        .from(enrollmentsTable)
        .where(eq(enrollmentsTable.courseId, course.id));

      let completedCount = 0;
      for (const { userId } of enrollments) {
        const completedInCourse = (await db
          .select()
          .from(userProgressTable)
          .where(
            and(
              eq(userProgressTable.userId, userId),
              eq(userProgressTable.completed, true)
            )
          )).filter((p) => lessons.some((l) => l.id === p.lessonId));

        if (lessons.length > 0 && completedInCourse.length === lessons.length) {
          completedCount++;
        }
      }

      const totalEnroll = enrollCount?.count ?? 0;
      const completionRate = totalEnroll > 0 ? Math.round((completedCount / totalEnroll) * 100) : 0;

      return {
        id: course.id,
        title: course.title,
        enrollmentCount: totalEnroll,
        completionRate,
        thumbnailUrl: course.thumbnailUrl ?? null,
      };
    })
  );

  // sort by enrollmentCount desc
  withStats.sort((a, b) => b.enrollmentCount - a.enrollmentCount);

  res.json(withStats.slice(0, 5));
});

export default router;
