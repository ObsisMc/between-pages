CREATE TABLE "shared_pages" (
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
	"title" text DEFAULT '' NOT NULL,
	"title_by" uuid,
	"title_at" timestamp with time zone,
	CONSTRAINT "shared_pages_deletion" CHECK (num_nulls("shared_pages"."deleted_at", "shared_pages"."deleted_by") in (0, 2)),
	CONSTRAINT "shared_pages_title" CHECK (char_length("shared_pages"."title") <= 60),
	CONSTRAINT "shared_pages_title_stamp" CHECK (num_nulls("shared_pages"."title_by", "shared_pages"."title_at") in (0, 2))
);
--> statement-breakpoint
ALTER TABLE "space_actions" DROP CONSTRAINT "space_actions_kind";--> statement-breakpoint
ALTER TABLE "space_changes" DROP CONSTRAINT "space_changes_record_type";--> statement-breakpoint
ALTER TABLE "space_reads" DROP CONSTRAINT "space_reads_record_type";--> statement-breakpoint
ALTER TABLE "shared_pages" ADD CONSTRAINT "shared_pages_id_documents_id_fk" FOREIGN KEY ("id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_pages_space" ON "shared_pages" USING btree ("space_id");--> statement-breakpoint
ALTER TABLE "space_actions" ADD CONSTRAINT "space_actions_kind" CHECK ((record_type = 'wish' and kind in ('prepare', 'unprepare', 'receive')) or (record_type = 'gift' and kind in ('reveal', 'set_date', 'set_occasion')) or (record_type = 'anniversary' and kind in ('set_date', 'set_count')) or (record_type = 'shared_page' and kind in ('renamed', 'wrote')));--> statement-breakpoint
ALTER TABLE "space_changes" ADD CONSTRAINT "space_changes_record_type" CHECK ("space_changes"."record_type" in ('wish', 'gift', 'gift_card', 'anniversary', 'shared_page'));--> statement-breakpoint
ALTER TABLE "space_reads" ADD CONSTRAINT "space_reads_record_type" CHECK ("space_reads"."record_type" in ('wish', 'gift', 'gift_card', 'anniversary', 'shared_page'));