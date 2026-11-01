CREATE SEQUENCE "public"."space_record_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "space_actions" (
	"seq" bigint PRIMARY KEY DEFAULT nextval('space_record_seq') NOT NULL,
	"space_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"private_to" uuid,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	CONSTRAINT "space_actions_request" UNIQUE("actor_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "space_changes" (
	"seq" bigint PRIMARY KEY DEFAULT nextval('space_record_seq') NOT NULL,
	"space_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"private_to" uuid,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid,
	"request_digest" text,
	CONSTRAINT "space_changes_request" UNIQUE("actor_id","request_id"),
	CONSTRAINT "space_changes_kind" CHECK ("space_changes"."kind" in ('create', 'edit', 'delete')),
	CONSTRAINT "space_changes_request_fields" CHECK (num_nulls("space_changes"."request_id", "space_changes"."request_digest") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "space_reads" (
	"user_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	CONSTRAINT "space_reads_user_id_record_type_record_id_pk" PRIMARY KEY("user_id","record_type","record_id")
);
--> statement-breakpoint
CREATE INDEX "space_actions_record" ON "space_actions" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE INDEX "space_actions_space" ON "space_actions" USING btree ("space_id","seq");--> statement-breakpoint
CREATE INDEX "space_changes_record" ON "space_changes" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE INDEX "space_changes_space" ON "space_changes" USING btree ("space_id","seq");