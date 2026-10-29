ALTER TABLE "users" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "timezone_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sleep_start_minute" smallint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sleep_end_minute" smallint;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_timezone_fields" CHECK (num_nulls("users"."timezone", "users"."timezone_updated_at") in (0, 2));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_sleep_fields" CHECK (num_nulls("users"."sleep_start_minute", "users"."sleep_end_minute") in (0, 2));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_sleep_grid" CHECK ("users"."sleep_start_minute" between 0 and 1425 and "users"."sleep_start_minute" % 15 = 0
        and "users"."sleep_end_minute" between 0 and 1425 and "users"."sleep_end_minute" % 15 = 0
        and "users"."sleep_start_minute" <> "users"."sleep_end_minute");