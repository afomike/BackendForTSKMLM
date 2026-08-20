ALTER TABLE "user_progress" ADD COLUMN IF NOT EXISTS "completed_parts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
