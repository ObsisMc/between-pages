CREATE TABLE "mail_marks" (
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"first_seen_at" timestamp with time zone,
	"first_seen_period" uuid,
	"notified_mark" integer,
	"notified_key" text,
	"notified_at" timestamp with time zone,
	CONSTRAINT "mail_marks_user_id_source_source_id_pk" PRIMARY KEY("user_id","source","source_id"),
	CONSTRAINT "mail_marks_source" CHECK ("mail_marks"."source" in ('diary', 'shared_page', 'wish', 'gift', 'gift_card', 'anniversary', 'backup'))
);
--> statement-breakpoint
CREATE TABLE "mail_notified_ranges" (
	"user_id" uuid NOT NULL,
	"diary_id" uuid NOT NULL,
	"client_id" bigint NOT NULL,
	"clocks" "int8multirange" NOT NULL,
	CONSTRAINT "mail_notified_ranges_user_id_diary_id_client_id_pk" PRIMARY KEY("user_id","diary_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "mail_sends" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"local_date" date NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"subject" text,
	"html" text,
	"text_body" text,
	"headers" jsonb,
	"marks" jsonb,
	"requested" boolean DEFAULT false NOT NULL,
	"last_requested_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_code" text,
	"provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "mail_sends_category" CHECK ("mail_sends"."category" in ('new_content', 'anniversary', 'backup')),
	CONSTRAINT "mail_sends_status" CHECK ("mail_sends"."status" in ('sending', 'sent', 'cancelled', 'unknown', 'failed', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE "mail_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"new_content" boolean DEFAULT true NOT NULL,
	"anniversary" boolean DEFAULT true NOT NULL,
	"backup" boolean DEFAULT true NOT NULL,
	"hint_dismissed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_marks" ADD CONSTRAINT "mail_marks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_notified_ranges" ADD CONSTRAINT "mail_notified_ranges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_notified_ranges" ADD CONSTRAINT "mail_notified_ranges_diary_id_diaries_id_fk" FOREIGN KEY ("diary_id") REFERENCES "public"."diaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_sends" ADD CONSTRAINT "mail_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD CONSTRAINT "mail_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_sends_one_sending" ON "mail_sends" USING btree ("user_id","category") WHERE "mail_sends"."status" = 'sending';--> statement-breakpoint
CREATE INDEX "mail_sends_due" ON "mail_sends" USING btree ("next_attempt_at") WHERE "mail_sends"."status" = 'sending';--> statement-breakpoint
CREATE INDEX "mail_sends_recent" ON "mail_sends" USING btree ("user_id","category","created_at");