CREATE TABLE "backup_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"diary_date" date
);
--> statement-breakpoint
CREATE TABLE "google_connections" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"google_user_id" text NOT NULL,
	"email" text NOT NULL,
	"refresh_token" "bytea" NOT NULL,
	"token_nonce" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"status" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "google_day_docs" (
	"doc_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"google_user_id" text NOT NULL,
	"diary_date" date NOT NULL,
	"state" text NOT NULL,
	"revision_id" text NOT NULL,
	"content_sha256" "bytea" NOT NULL,
	"covers" jsonb NOT NULL,
	"covered_at" timestamp with time zone NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_day_work" (
	"user_id" uuid NOT NULL,
	"diary_date" date NOT NULL,
	"ready_at" timestamp with time zone DEFAULT now() NOT NULL,
	"now" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "google_day_work_user_id_diary_date_pk" PRIMARY KEY("user_id","diary_date")
);
--> statement-breakpoint
CREATE TABLE "google_folders" (
	"user_id" uuid NOT NULL,
	"google_user_id" text NOT NULL,
	"path" text NOT NULL,
	"folder_id" text NOT NULL,
	CONSTRAINT "google_folders_user_id_google_user_id_path_pk" PRIMARY KEY("user_id","google_user_id","path")
);
--> statement-breakpoint
CREATE TABLE "google_oauth_states" (
	"state_sha256" "bytea" PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backup_outbox" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "backup_events" ADD CONSTRAINT "backup_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_day_docs" ADD CONSTRAINT "google_day_docs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_day_work" ADD CONSTRAINT "google_day_work_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_folders" ADD CONSTRAINT "google_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_events_user" ON "backup_events" USING btree ("user_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "google_day_docs_current" ON "google_day_docs" USING btree ("user_id","google_user_id","diary_date") WHERE "google_day_docs"."state" = 'current';--> statement-breakpoint
CREATE INDEX "backup_outbox_pending" ON "backup_outbox" USING btree ("created_at") WHERE "backup_outbox"."status" = 'pending';