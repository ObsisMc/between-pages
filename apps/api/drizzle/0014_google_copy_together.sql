CREATE TABLE "google_item_docs" (
	"doc_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"google_user_id" text NOT NULL,
	"item" text NOT NULL,
	"state" text NOT NULL,
	"title" text,
	"rename_intent" jsonb,
	"revision_id" text NOT NULL,
	"content_sha256" "bytea" NOT NULL,
	"covered_at" timestamp with time zone NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_item_work" (
	"user_id" uuid NOT NULL,
	"item" text NOT NULL,
	"ready_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"now" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "google_item_work_user_id_item_pk" PRIMARY KEY("user_id","item")
);
--> statement-breakpoint
CREATE TABLE "space_copy_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"record_type" text,
	"record_id" uuid,
	"private_to" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "space_copy_outbox_record" CHECK (num_nulls("space_copy_outbox"."record_type", "space_copy_outbox"."record_id") in (0, 2))
);
--> statement-breakpoint
ALTER TABLE "backup_events" ADD COLUMN "item" text;--> statement-breakpoint
ALTER TABLE "backup_events" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "google_item_docs" ADD CONSTRAINT "google_item_docs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_item_docs_current" ON "google_item_docs" USING btree ("user_id","google_user_id","item") WHERE "google_item_docs"."state" = 'current';--> statement-breakpoint
CREATE INDEX "space_copy_outbox_pending" ON "space_copy_outbox" USING btree ("created_at") WHERE "space_copy_outbox"."status" = 'pending';--> statement-breakpoint
WITH "ranked" AS (
	SELECT "user_id", "email", row_number() OVER (PARTITION BY "google_user_id" ORDER BY "connected_at", "user_id") AS "rank"
	FROM "google_connections"
), "dropped" AS (
	DELETE FROM "google_connections" WHERE "user_id" IN (SELECT "user_id" FROM "ranked" WHERE "rank" > 1)
	RETURNING "user_id", "email"
)
INSERT INTO "backup_events" ("user_id", "kind", "email") SELECT "user_id", 'account_in_use', "email" FROM "dropped";--> statement-breakpoint
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_account" UNIQUE("google_user_id");--> statement-breakpoint
INSERT INTO "google_item_work" ("user_id", "item")
SELECT c."user_id", i."item" FROM "google_connections" c
JOIN "spaces" s ON c."user_id" IN (s."user_low", s."user_high")
CROSS JOIN (VALUES ('wishes'), ('gifts'), ('anniversaries')) AS i("item")
WHERE c."status" <> 'revoking'
UNION
SELECT c."user_id", 'page:' || p."id" FROM "google_connections" c
JOIN "spaces" s ON c."user_id" IN (s."user_low", s."user_high")
JOIN "shared_pages" p ON p."space_id" = s."id" AND p."deleted_at" IS NULL
WHERE c."status" <> 'revoking'
ON CONFLICT DO NOTHING;