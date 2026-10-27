CREATE TABLE "diary_read_ranges" (
	"user_id" uuid NOT NULL,
	"diary_id" uuid NOT NULL,
	"client_id" bigint NOT NULL,
	"clocks" "int8multirange" NOT NULL,
	CONSTRAINT "diary_read_ranges_user_id_diary_id_client_id_pk" PRIMARY KEY("user_id","diary_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "share_epochs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"diary_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"frozen_version" bigint,
	CONSTRAINT "share_epochs_close_fields" CHECK (num_nulls("share_epochs"."closed_at", "share_epochs"."frozen_version") in (0, 2))
);
--> statement-breakpoint
ALTER TABLE "backup_outbox" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "backup_outbox" ADD COLUMN "epoch_id" uuid;--> statement-breakpoint
ALTER TABLE "diary_commits" ADD COLUMN "epoch_id" uuid;--> statement-breakpoint
ALTER TABLE "diary_read_ranges" ADD CONSTRAINT "diary_read_ranges_diary_id_diaries_id_fk" FOREIGN KEY ("diary_id") REFERENCES "public"."diaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_epochs" ADD CONSTRAINT "share_epochs_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_epochs" ADD CONSTRAINT "share_epochs_diary_id_diaries_id_fk" FOREIGN KEY ("diary_id") REFERENCES "public"."diaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_epochs" ADD CONSTRAINT "share_epochs_period" FOREIGN KEY ("period_id","space_id") REFERENCES "public"."binding_periods"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_epochs" ADD CONSTRAINT "share_epochs_generation" FOREIGN KEY ("diary_id","generation_id") REFERENCES "public"."diary_generations"("diary_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_epochs" ADD CONSTRAINT "share_epochs_frozen" FOREIGN KEY ("diary_id","frozen_version") REFERENCES "public"."diary_commits"("diary_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "share_epochs_one_live" ON "share_epochs" USING btree ("diary_id") WHERE "share_epochs"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "share_epochs_recipient" ON "share_epochs" USING btree ("recipient_id","space_id");--> statement-breakpoint
ALTER TABLE "backup_outbox" ADD CONSTRAINT "backup_outbox_epoch_id_share_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."share_epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_commits" ADD CONSTRAINT "diary_commits_epoch_id_share_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."share_epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diary_commits_epoch" ON "diary_commits" USING btree ("epoch_id");--> statement-breakpoint
ALTER TABLE "backup_outbox" ADD CONSTRAINT "backup_outbox_space_fields" CHECK (case "backup_outbox"."target" when 'space' then num_nulls("backup_outbox"."space_id", "backup_outbox"."epoch_id") = 0
        else num_nonnulls("backup_outbox"."space_id", "backup_outbox"."epoch_id") = 0 end);--> statement-breakpoint
-- Hand-added data change (approved for kernel phase 4): ranges confirmed while saving only
-- configured them are kept for reference and never count as authorization to publish
-- (kernel D5); each person confirms again to open diaries.
UPDATE "sharing_policies" SET "confirmed_period_id" = NULL;
