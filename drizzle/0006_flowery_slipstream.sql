ALTER TABLE "user_progress" ADD COLUMN IF NOT EXISTS "playback_positions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user_progress" ADD COLUMN IF NOT EXISTS "last_viewed_at" timestamp with time zone;
