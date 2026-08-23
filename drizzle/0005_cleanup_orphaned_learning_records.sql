-- Remove records left behind by deletions made before foreign-key cascades
-- were deployed. The normal delete endpoints now prevent new orphans.
DELETE FROM "quiz_options"
WHERE NOT EXISTS (
  SELECT 1 FROM "quiz_questions"
  WHERE "quiz_questions"."id" = "quiz_options"."question_id"
);--> statement-breakpoint
DELETE FROM "quiz_questions"
WHERE NOT EXISTS (
  SELECT 1 FROM "quizzes"
  WHERE "quizzes"."id" = "quiz_questions"."quiz_id"
);--> statement-breakpoint
DELETE FROM "quiz_attempts"
WHERE NOT EXISTS (
  SELECT 1 FROM "quizzes"
  WHERE "quizzes"."id" = "quiz_attempts"."quiz_id"
);--> statement-breakpoint
DELETE FROM "quizzes"
WHERE NOT EXISTS (
  SELECT 1 FROM "lessons"
  WHERE "lessons"."id" = "quizzes"."lesson_id"
);--> statement-breakpoint
DELETE FROM "quiz_questions"
WHERE NOT EXISTS (
  SELECT 1 FROM "quizzes"
  WHERE "quizzes"."id" = "quiz_questions"."quiz_id"
);--> statement-breakpoint
DELETE FROM "quiz_options"
WHERE NOT EXISTS (
  SELECT 1 FROM "quiz_questions"
  WHERE "quiz_questions"."id" = "quiz_options"."question_id"
);--> statement-breakpoint
DELETE FROM "user_progress"
WHERE NOT EXISTS (
  SELECT 1 FROM "lessons"
  WHERE "lessons"."id" = "user_progress"."lesson_id"
);--> statement-breakpoint
DELETE FROM "user_progress"
WHERE NOT EXISTS (
  SELECT 1 FROM "users"
  WHERE "users"."id" = "user_progress"."user_id"
);--> statement-breakpoint
DELETE FROM "lessons"
WHERE NOT EXISTS (
  SELECT 1 FROM "courses"
  WHERE "courses"."id" = "lessons"."course_id"
);--> statement-breakpoint
DELETE FROM "enrollments"
WHERE NOT EXISTS (
  SELECT 1 FROM "courses"
  WHERE "courses"."id" = "enrollments"."course_id"
);--> statement-breakpoint
DELETE FROM "assignment_submissions"
WHERE NOT EXISTS (
  SELECT 1 FROM "courses"
  WHERE "courses"."id" = "assignment_submissions"."course_id"
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_progress_user_id_users_id_fk') THEN
    ALTER TABLE "user_progress" ADD CONSTRAINT "user_progress_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_progress_lesson_id_lessons_id_fk') THEN
    ALTER TABLE "user_progress" ADD CONSTRAINT "user_progress_lesson_id_lessons_id_fk"
      FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE;
  END IF;
END $$;
