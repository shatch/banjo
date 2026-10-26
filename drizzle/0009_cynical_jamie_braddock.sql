ALTER TABLE "contacts" ADD COLUMN "do_not_call_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "requested_by_agent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "screen_flag" text;--> statement-breakpoint
-- Until #150 only an agent's request had an approval window, so those are the agent's.
UPDATE "tasks" SET "requested_by_agent" = true WHERE "approval_expires_at" IS NOT NULL;
