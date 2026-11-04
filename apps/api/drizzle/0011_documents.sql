CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"generation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "documents" ("id", "version", "generation_id", "created_at")
	SELECT "id", "version", "generation_id", "created_at" FROM "diaries";
--> statement-breakpoint
ALTER TABLE "diary_client_bindings" DROP CONSTRAINT "diary_client_bindings_diary_id_diaries_id_fk";
--> statement-breakpoint
ALTER TABLE "diary_generations" DROP CONSTRAINT "diary_generations_diary_id_diaries_id_fk";
--> statement-breakpoint
ALTER TABLE "diaries" ADD CONSTRAINT "diaries_id_documents_id_fk" FOREIGN KEY ("id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_client_bindings" ADD CONSTRAINT "diary_client_bindings_diary_id_documents_id_fk" FOREIGN KEY ("diary_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_generations" ADD CONSTRAINT "diary_generations_diary_id_documents_id_fk" FOREIGN KEY ("diary_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diaries" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "diaries" DROP COLUMN "generation_id";