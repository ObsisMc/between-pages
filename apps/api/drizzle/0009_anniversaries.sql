CREATE TABLE "anniversaries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"created_period_id" uuid NOT NULL,
	"private_to" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"kind" text NOT NULL,
	"birthday_of" uuid,
	"name" text,
	"note" text,
	"year" smallint,
	"month" smallint NOT NULL,
	"day" smallint NOT NULL,
	"date_set_by" uuid,
	"date_set_at" timestamp with time zone,
	"show_count" boolean NOT NULL,
	"count_set_by" uuid,
	"count_set_at" timestamp with time zone,
	CONSTRAINT "anniversaries_kind" CHECK ("anniversaries"."kind" in ('birthday', 'together', 'other')),
	CONSTRAINT "anniversaries_kind_fields" CHECK (("anniversaries"."kind" = 'birthday') = ("anniversaries"."birthday_of" is not null)
        and ("anniversaries"."kind" = 'other') = ("anniversaries"."name" is not null)
        and ("anniversaries"."kind" = 'birthday' or "anniversaries"."year" is not null)),
	CONSTRAINT "anniversaries_date" CHECK ("anniversaries"."month" between 1 and 12 and "anniversaries"."day" between 1 and 31
        and make_date(coalesce("anniversaries"."year", 2000), "anniversaries"."month", 1) + ("anniversaries"."day" - 1)
          < make_date(coalesce("anniversaries"."year", 2000), "anniversaries"."month", 1) + interval '1 month'),
	CONSTRAINT "anniversaries_count" CHECK (not "anniversaries"."show_count" or "anniversaries"."year" is not null),
	CONSTRAINT "anniversaries_not_private" CHECK ("anniversaries"."private_to" is null),
	CONSTRAINT "anniversaries_date_set" CHECK (num_nulls("anniversaries"."date_set_by", "anniversaries"."date_set_at") in (0, 2)),
	CONSTRAINT "anniversaries_count_set" CHECK (num_nulls("anniversaries"."count_set_by", "anniversaries"."count_set_at") in (0, 2)),
	CONSTRAINT "anniversaries_deleted" CHECK (num_nulls("anniversaries"."deleted_at", "anniversaries"."deleted_by") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "anniversary_reminders" (
	"user_id" uuid NOT NULL,
	"anniversary_id" uuid NOT NULL,
	"days" smallint,
	CONSTRAINT "anniversary_reminders_user_id_anniversary_id_pk" PRIMARY KEY("user_id","anniversary_id"),
	CONSTRAINT "anniversary_reminders_days" CHECK ("anniversary_reminders"."days" in (0, 1, 3, 7, 14, 30))
);
--> statement-breakpoint
ALTER TABLE "space_actions" DROP CONSTRAINT "space_actions_kind";--> statement-breakpoint
ALTER TABLE "space_changes" DROP CONSTRAINT "space_changes_record_type";--> statement-breakpoint
ALTER TABLE "space_reads" DROP CONSTRAINT "space_reads_record_type";--> statement-breakpoint
ALTER TABLE "gifts" ADD COLUMN "occasion_anniversary_id" uuid;--> statement-breakpoint
ALTER TABLE "gifts" ADD COLUMN "occasion_name" text;--> statement-breakpoint
CREATE INDEX "anniversaries_space" ON "anniversaries" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "anniversaries_together" ON "anniversaries" USING btree ("space_id") WHERE "anniversaries"."kind" = 'together' and "anniversaries"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_occasion_anniversary_id_anniversaries_id_fk" FOREIGN KEY ("occasion_anniversary_id") REFERENCES "public"."anniversaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gifts_occasion_anniversary" ON "gifts" USING btree ("occasion_anniversary_id");--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_occasion_one" CHECK ("gifts"."occasion" is null or "gifts"."occasion_anniversary_id" is null);--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_occasion_name" CHECK (num_nulls("gifts"."occasion_anniversary_id", "gifts"."occasion_name") in (0, 2));--> statement-breakpoint
ALTER TABLE "space_actions" ADD CONSTRAINT "space_actions_kind" CHECK ((record_type = 'wish' and kind in ('prepare', 'unprepare', 'receive')) or (record_type = 'gift' and kind in ('reveal', 'set_date', 'set_occasion')) or (record_type = 'anniversary' and kind in ('set_date', 'set_count')));--> statement-breakpoint
ALTER TABLE "space_changes" ADD CONSTRAINT "space_changes_record_type" CHECK ("space_changes"."record_type" in ('wish', 'gift', 'gift_card', 'anniversary'));--> statement-breakpoint
ALTER TABLE "space_reads" ADD CONSTRAINT "space_reads_record_type" CHECK ("space_reads"."record_type" in ('wish', 'gift', 'gift_card', 'anniversary'));