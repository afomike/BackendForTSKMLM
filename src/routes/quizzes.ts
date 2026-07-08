import { Router } from "express";
import { db } from "../lib/db.js";
import {
  quizzesTable,
  quizQuestionsTable,
  quizOptionsTable,
  quizAttemptsTable,
  lessonsTable,
  enrollmentsTable,
} from "../lib/db.js";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../lib/auth.js";

const router = Router();

// ── Validation helpers ────────────────────────────────────────────────────────

function validateUpsertQuiz(body: unknown): {
  passingScore: number;
  questions: Array<{ questionText: string; options: Array<{ optionText: string; isCorrect: boolean }> }>;
} | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const passingScore = typeof b["passingScore"] === "number" ? Math.round(b["passingScore"]) : 70;
  if (passingScore < 1 || passingScore > 100) return null;
  if (!Array.isArray(b["questions"]) || b["questions"].length < 1) return null;
  const questions = (b["questions"] as unknown[]).map((q: unknown) => {
    if (!q || typeof q !== "object") return null;
    const qo = q as Record<string, unknown>;
    if (typeof qo["questionText"] !== "string" || !qo["questionText"].trim()) return null;
    if (!Array.isArray(qo["options"]) || qo["options"].length < 2) return null;
    const options = (qo["options"] as unknown[]).map((o: unknown) => {
      if (!o || typeof o !== "object") return null;
      const oo = o as Record<string, unknown>;
      if (typeof oo["optionText"] !== "string" || !oo["optionText"].trim()) return null;
      return { optionText: oo["optionText"] as string, isCorrect: !!oo["isCorrect"] };
    });
    if (options.some((o) => o === null)) return null;
    return { questionText: qo["questionText"] as string, options: options as Array<{ optionText: string; isCorrect: boolean }> };
  });
  if (questions.some((q) => q === null)) return null;
  return { passingScore, questions: questions as Array<{ questionText: string; options: Array<{ optionText: string; isCorrect: boolean }> }> };
}

function validateSubmitAttempt(body: unknown): { answers: Record<string, string> } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!b["answers"] || typeof b["answers"] !== "object" || Array.isArray(b["answers"])) return null;
  const answers = b["answers"] as Record<string, unknown>;
  for (const v of Object.values(answers)) {
    if (typeof v !== "string") return null;
  }
  return { answers: answers as Record<string, string> };
}

// ── Admin: GET quiz for a lesson ─────────────────────────────────────────────

router.get("/lessons/:lessonId/quiz", requireAuth, async (req, res): Promise<void> => {
  const lessonId = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  if (!lessonId) {
    res.status(400).json({ error: "Missing lessonId" });
    return;
  }

  const [quiz] = await db
    .select()
    .from(quizzesTable)
    .where(eq(quizzesTable.lessonId, lessonId));

  if (!quiz) {
    res.status(404).json({ error: "No quiz for this lesson" });
    return;
  }

  const questions = await db
    .select()
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quizId, quiz.id))
    .orderBy(quizQuestionsTable.questionOrder);

  const questionsWithOptions = await Promise.all(
    questions.map(async (q) => {
      const options = await db
        .select()
        .from(quizOptionsTable)
        .where(eq(quizOptionsTable.questionId, q.id))
        .orderBy(quizOptionsTable.optionOrder);

      const isAdmin = req.userRole === "admin";
      return {
        id: q.id,
        questionText: q.questionText,
        questionOrder: q.questionOrder,
        options: options.map((o) => ({
          id: o.id,
          optionText: o.optionText,
          optionOrder: o.optionOrder,
          // only expose correct flag to admins
          ...(isAdmin ? { isCorrect: o.isCorrect } : {}),
        })),
      };
    })
  );

  res.json({
    id: quiz.id,
    lessonId: quiz.lessonId,
    passingScore: quiz.passingScore,
    questions: questionsWithOptions,
  });
});

// ── Admin: upsert (create or replace) quiz for a lesson ──────────────────────

router.put("/lessons/:lessonId/quiz", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const lessonId = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  if (!lessonId) {
    res.status(400).json({ error: "Missing lessonId" });
    return;
  }

  const parsed = validateUpsertQuiz(req.body);
  if (!parsed) {
    res.status(400).json({ error: "Invalid quiz data. Questions and options are required." });
    return;
  }

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId));

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  const { passingScore, questions } = parsed;

  // Upsert quiz row
  const [quiz] = await db
    .insert(quizzesTable)
    .values({ lessonId, passingScore })
    .onConflictDoUpdate({
      target: quizzesTable.lessonId,
      set: { passingScore, updatedAt: new Date() },
    })
    .returning();

  // Delete all existing questions (cascades to options)
  await db.delete(quizQuestionsTable).where(eq(quizQuestionsTable.quizId, quiz.id));

  // Re-insert questions + options
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const [newQ] = await db
      .insert(quizQuestionsTable)
      .values({ quizId: quiz.id, questionText: q.questionText, questionOrder: qi })
      .returning();

    for (let oi = 0; oi < q.options.length; oi++) {
      const o = q.options[oi];
      await db.insert(quizOptionsTable).values({
        questionId: newQ.id,
        optionText: o.optionText,
        isCorrect: o.isCorrect,
        optionOrder: oi,
      });
    }
  }

  res.json({ message: "Quiz saved", quizId: quiz.id });
});

// ── Admin: delete quiz for a lesson ──────────────────────────────────────────

router.delete("/lessons/:lessonId/quiz", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const lessonId = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  if (!lessonId) {
    res.status(400).json({ error: "Missing lessonId" });
    return;
  }

  await db.delete(quizzesTable).where(eq(quizzesTable.lessonId, lessonId));

  res.json({ message: "Quiz deleted" });
});

// ── Student: submit a quiz attempt ───────────────────────────────────────────

router.post("/lessons/:lessonId/quiz/attempt", requireAuth, async (req, res): Promise<void> => {
  const lessonId = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  if (!lessonId) {
    res.status(400).json({ error: "Missing lessonId" });
    return;
  }

  const parsed = validateSubmitAttempt(req.body);
  if (!parsed) {
    res.status(400).json({ error: "Invalid submission. Provide answers as { questionId: optionId }." });
    return;
  }

  // Check enrolled
  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId));

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

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

  const [quiz] = await db
    .select()
    .from(quizzesTable)
    .where(eq(quizzesTable.lessonId, lessonId));

  if (!quiz) {
    res.status(404).json({ error: "No quiz for this lesson" });
    return;
  }

  const questions = await db
    .select()
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quizId, quiz.id));

  const { answers } = parsed;

  // Score the attempt
  let correct = 0;
  const feedback: Array<{
    questionId: string;
    questionText: string;
    chosenOptionId: string | null;
    correctOptionId: string;
    isCorrect: boolean;
  }> = [];

  for (const question of questions) {
    const options = await db
      .select()
      .from(quizOptionsTable)
      .where(eq(quizOptionsTable.questionId, question.id));

    const correctOption = options.find((o) => o.isCorrect);
    const chosenId = answers[question.id] ?? null;
    const isCorrect = !!chosenId && chosenId === correctOption?.id;

    if (isCorrect) correct++;

    feedback.push({
      questionId: question.id,
      questionText: question.questionText,
      chosenOptionId: chosenId,
      correctOptionId: correctOption?.id ?? "",
      isCorrect,
    });
  }

  const total = questions.length;
  const score = total > 0 ? Math.round((correct / total) * 100) : 0;
  const passed = score >= quiz.passingScore;

  // Save attempt
  await db.insert(quizAttemptsTable).values({
    quizId: quiz.id,
    userId: req.userId!,
    score,
    passed,
  });

  res.json({ score, passingScore: quiz.passingScore, passed, correct, total, feedback });
});

// ── Student: get best attempt for a lesson quiz ───────────────────────────────

router.get("/lessons/:lessonId/quiz/best-attempt", requireAuth, async (req, res): Promise<void> => {
  const lessonId = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  if (!lessonId) {
    res.status(400).json({ error: "Missing lessonId" });
    return;
  }

  const [quiz] = await db
    .select()
    .from(quizzesTable)
    .where(eq(quizzesTable.lessonId, lessonId));

  if (!quiz) {
    res.json({ hasPassed: false, bestScore: null });
    return;
  }

  const attempts = await db
    .select()
    .from(quizAttemptsTable)
    .where(
      and(
        eq(quizAttemptsTable.quizId, quiz.id),
        eq(quizAttemptsTable.userId, req.userId!)
      )
    )
    .orderBy(desc(quizAttemptsTable.score));

  if (attempts.length === 0) {
    res.json({ hasPassed: false, bestScore: null, passingScore: quiz.passingScore });
    return;
  }

  const best = attempts[0];
  res.json({ hasPassed: best.passed, bestScore: best.score, passingScore: quiz.passingScore });
});

export default router;
