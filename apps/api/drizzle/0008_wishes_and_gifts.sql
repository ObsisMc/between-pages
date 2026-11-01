CREATE TABLE "gift_cards" (
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
	"gift_id" uuid NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "gift_cards_gift" UNIQUE("gift_id"),
	CONSTRAINT "gift_cards_deleted" CHECK (num_nulls("gift_cards"."deleted_at", "gift_cards"."deleted_by") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "gifts" (
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
	"giver_id" uuid NOT NULL,
	"receiver_id" uuid NOT NULL,
	"wish_id" uuid,
	"name" text NOT NULL,
	"link" text,
	"preview_title" text,
	"preview_site" text,
	"preview_image" text,
	"preview_read_at" timestamp with time zone,
	"status" text NOT NULL,
	"revealed_at" timestamp with time zone,
	"revealed_by" uuid,
	"gift_date" date,
	"date_set_by" uuid,
	"date_set_at" timestamp with time zone,
	"occasion" text,
	"occasion_set_by" uuid,
	"occasion_set_at" timestamp with time zone,
	CONSTRAINT "gifts_status" CHECK (case "gifts"."status"
        when 'preparing' then "gifts"."private_to" is not distinct from "gifts"."giver_id"
          and num_nonnulls("gifts"."revealed_at", "gifts"."revealed_by", "gifts"."gift_date") = 0
        when 'revealed' then "gifts"."private_to" is null
          and num_nulls("gifts"."revealed_at", "gifts"."revealed_by", "gifts"."gift_date") = 0
        else false end),
	CONSTRAINT "gifts_parties" CHECK ("gifts"."giver_id" <> "gifts"."receiver_id"),
	CONSTRAINT "gifts_occasion" CHECK ("gifts"."occasion" in ('holiday', 'meeting', 'no_reason')),
	CONSTRAINT "gifts_date_set" CHECK (num_nulls("gifts"."date_set_by", "gifts"."date_set_at") in (0, 2)),
	CONSTRAINT "gifts_occasion_set" CHECK (num_nulls("gifts"."occasion_set_by", "gifts"."occasion_set_at") in (0, 2)),
	CONSTRAINT "gifts_deleted" CHECK (num_nulls("gifts"."deleted_at", "gifts"."deleted_by") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "wishes" (
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
	"name" text NOT NULL,
	"link" text,
	"note" text,
	"want" smallint,
	"preview_title" text,
	"preview_site" text,
	"preview_image" text,
	"preview_read_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	CONSTRAINT "wishes_want" CHECK ("wishes"."want" between 1 and 5),
	CONSTRAINT "wishes_not_private" CHECK ("wishes"."private_to" is null),
	CONSTRAINT "wishes_deleted" CHECK (num_nulls("wishes"."deleted_at", "wishes"."deleted_by") in (0, 2)),
	CONSTRAINT "wishes_received" CHECK (num_nulls("wishes"."received_at", "wishes"."received_by") in (0, 2))
);
--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_gift_id_gifts_id_fk" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_wish_id_wishes_id_fk" FOREIGN KEY ("wish_id") REFERENCES "public"."wishes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gifts_space" ON "gifts" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gifts_preparing_wish" ON "gifts" USING btree ("wish_id") WHERE "gifts"."status" = 'preparing' and "gifts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "gifts_preview_pending" ON "gifts" USING btree ("created_at") WHERE "gifts"."link" is not null and "gifts"."preview_read_at" is null;--> statement-breakpoint
CREATE INDEX "wishes_space" ON "wishes" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "wishes_preview_pending" ON "wishes" USING btree ("created_at") WHERE "wishes"."link" is not null and "wishes"."preview_read_at" is null;--> statement-breakpoint
ALTER TABLE "space_actions" ADD CONSTRAINT "space_actions_kind" CHECK ((record_type = 'wish' and kind in ('prepare', 'unprepare', 'receive')) or (record_type = 'gift' and kind in ('reveal', 'set_date', 'set_occasion')));--> statement-breakpoint
ALTER TABLE "space_changes" ADD CONSTRAINT "space_changes_record_type" CHECK ("space_changes"."record_type" in ('wish', 'gift', 'gift_card'));--> statement-breakpoint
ALTER TABLE "space_reads" ADD CONSTRAINT "space_reads_record_type" CHECK ("space_reads"."record_type" in ('wish', 'gift', 'gift_card'));