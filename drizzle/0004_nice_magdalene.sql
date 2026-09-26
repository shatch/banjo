ALTER TYPE "public"."task_status" ADD VALUE 'transferred' BEFORE 'failed';--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "transfer_result" text;