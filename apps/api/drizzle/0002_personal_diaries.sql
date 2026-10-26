CREATE TABLE "backup_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"diary_id" uuid NOT NULL,
	"version" bigint NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_outbox_target" UNIQUE("diary_id","version","target")
);
--> statement-breakpoint
CREATE TABLE "diaries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"diary_date" date NOT NULL,
	"created_timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"generation_id" uuid NOT NULL,
	CONSTRAINT "diaries_owner_date" UNIQUE("owner_id","diary_date")
);
--> statement-breakpoint
CREATE TABLE "diary_character_ranges" (
	"diary_id" uuid NOT NULL,
	"client_id" bigint NOT NULL,
	"clock_start" bigint NOT NULL,
	"clock_end" bigint NOT NULL,
	"operation_id" uuid NOT NULL,
	CONSTRAINT "diary_character_ranges_diary_id_client_id_clock_start_pk" PRIMARY KEY("diary_id","client_id","clock_start"),
	CONSTRAINT "diary_character_ranges_nonempty" CHECK ("diary_character_ranges"."clock_end" > "diary_character_ranges"."clock_start")
);
--> statement-breakpoint
CREATE TABLE "diary_client_bindings" (
	"diary_id" uuid NOT NULL,
	"client_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "diary_client_bindings_diary_id_client_id_pk" PRIMARY KEY("diary_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "diary_commits" (
	"diary_id" uuid NOT NULL,
	"version" bigint NOT NULL,
	"public_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"batch_id" uuid,
	"author_id" uuid,
	"batch_digest" "bytea",
	"digest_algorithm" smallint,
	"delta" "bytea" NOT NULL,
	"delta_sha256" "bytea" NOT NULL,
	"committed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "diary_commits_diary_id_version_pk" PRIMARY KEY("diary_id","version"),
	CONSTRAINT "diary_commits_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "diary_commits_generation_seq" UNIQUE("diary_id","generation_id","seq"),
	CONSTRAINT "diary_commits_batch" UNIQUE("diary_id","batch_id"),
	CONSTRAINT "diary_commits_batch_fields" CHECK (num_nulls("diary_commits"."batch_id", "diary_commits"."author_id", "diary_commits"."batch_digest", "diary_commits"."digest_algorithm") in (0, 4))
);
--> statement-breakpoint
CREATE TABLE "diary_generations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"diary_id" uuid NOT NULL,
	"source_version" bigint NOT NULL,
	"baseline" "bytea" NOT NULL,
	"baseline_sha256" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_generations_diary_id" UNIQUE("diary_id","id")
);
--> statement-breakpoint
CREATE TABLE "diary_operations" (
	"author_id" uuid NOT NULL,
	"diary_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"version" bigint NOT NULL,
	"batch_index" integer NOT NULL,
	"update_sha256" "bytea" NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_operations_author_id_diary_id_operation_id_pk" PRIMARY KEY("author_id","diary_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "diary_snapshots" (
	"diary_id" uuid NOT NULL,
	"version" bigint NOT NULL,
	"state" "bytea" NOT NULL,
	"state_sha256" "bytea" NOT NULL,
	CONSTRAINT "diary_snapshots_diary_id_version_pk" PRIMARY KEY("diary_id","version")
);
--> statement-breakpoint
ALTER TABLE "backup_outbox" ADD CONSTRAINT "backup_outbox_diary_id_version_diary_commits_diary_id_version_fk" FOREIGN KEY ("diary_id","version") REFERENCES "public"."diary_commits"("diary_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diaries" ADD CONSTRAINT "diaries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_character_ranges" ADD CONSTRAINT "diary_character_ranges_diary_id_client_id_diary_client_bindings_diary_id_client_id_fk" FOREIGN KEY ("diary_id","client_id") REFERENCES "public"."diary_client_bindings"("diary_id","client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_client_bindings" ADD CONSTRAINT "diary_client_bindings_diary_id_diaries_id_fk" FOREIGN KEY ("diary_id") REFERENCES "public"."diaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_commits" ADD CONSTRAINT "diary_commits_diary_id_generation_id_diary_generations_diary_id_id_fk" FOREIGN KEY ("diary_id","generation_id") REFERENCES "public"."diary_generations"("diary_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_generations" ADD CONSTRAINT "diary_generations_diary_id_diaries_id_fk" FOREIGN KEY ("diary_id") REFERENCES "public"."diaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_operations" ADD CONSTRAINT "diary_operations_diary_id_version_diary_commits_diary_id_version_fk" FOREIGN KEY ("diary_id","version") REFERENCES "public"."diary_commits"("diary_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_snapshots" ADD CONSTRAINT "diary_snapshots_diary_id_version_diary_commits_diary_id_version_fk" FOREIGN KEY ("diary_id","version") REFERENCES "public"."diary_commits"("diary_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diary_operations_commit" ON "diary_operations" USING btree ("diary_id","version","batch_index");