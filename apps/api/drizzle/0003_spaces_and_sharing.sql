CREATE TABLE "active_bindings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"period_id" uuid NOT NULL,
	"space_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "binding_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_by" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"confirmed_selection" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	CONSTRAINT "binding_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "binding_invitations_request" UNIQUE("created_by","request_id"),
	CONSTRAINT "binding_invitations_expiry" CHECK ("binding_invitations"."expires_at" > "binding_invitations"."created_at"),
	CONSTRAINT "binding_invitations_accept_fields" CHECK (num_nulls("binding_invitations"."accepted_at", "binding_invitations"."accepted_by") in (0, 2)),
	CONSTRAINT "binding_invitations_closed_once" CHECK ("binding_invitations"."revoked_at" is null or "binding_invitations"."accepted_at" is null)
);
--> statement-breakpoint
CREATE TABLE "binding_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	CONSTRAINT "binding_periods_id_space" UNIQUE("id","space_id"),
	CONSTRAINT "binding_periods_end_fields" CHECK (num_nulls("binding_periods"."ended_at", "binding_periods"."ended_by") in (0, 2)),
	CONSTRAINT "binding_periods_end_order" CHECK ("binding_periods"."ended_at" >= "binding_periods"."started_at")
);
--> statement-breakpoint
CREATE TABLE "sharing_policies" (
	"space_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"selection" jsonb DEFAULT '{"include":[],"exclude":[]}'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"confirmed_period_id" uuid,
	CONSTRAINT "sharing_policies_space_id_owner_id_pk" PRIMARY KEY("space_id","owner_id"),
	CONSTRAINT "sharing_policies_revision" CHECK ("sharing_policies"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sharing_policy_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"from_revision" integer NOT NULL,
	"to_revision" integer NOT NULL,
	"selection" jsonb NOT NULL,
	"period_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sharing_policy_changes_request" UNIQUE("owner_id","request_id"),
	CONSTRAINT "sharing_policy_changes_step" CHECK ("sharing_policy_changes"."to_revision" = "sharing_policy_changes"."from_revision" + 1)
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_low" uuid NOT NULL,
	"user_high" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_pair" UNIQUE("user_low","user_high"),
	CONSTRAINT "spaces_pair_ordered" CHECK ("spaces"."user_low" < "spaces"."user_high")
);
--> statement-breakpoint
ALTER TABLE "active_bindings" ADD CONSTRAINT "active_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_bindings" ADD CONSTRAINT "active_bindings_period" FOREIGN KEY ("period_id","space_id") REFERENCES "public"."binding_periods"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding_invitations" ADD CONSTRAINT "binding_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding_invitations" ADD CONSTRAINT "binding_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding_periods" ADD CONSTRAINT "binding_periods_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding_periods" ADD CONSTRAINT "binding_periods_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_policies" ADD CONSTRAINT "sharing_policies_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_policies" ADD CONSTRAINT "sharing_policies_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_policies" ADD CONSTRAINT "sharing_policies_confirmed_period" FOREIGN KEY ("confirmed_period_id","space_id") REFERENCES "public"."binding_periods"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_policy_changes" ADD CONSTRAINT "sharing_policy_changes_policy" FOREIGN KEY ("space_id","owner_id") REFERENCES "public"."sharing_policies"("space_id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_policy_changes" ADD CONSTRAINT "sharing_policy_changes_period" FOREIGN KEY ("period_id","space_id") REFERENCES "public"."binding_periods"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_user_low_users_id_fk" FOREIGN KEY ("user_low") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_user_high_users_id_fk" FOREIGN KEY ("user_high") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "binding_invitations_one_open" ON "binding_invitations" USING btree ("created_by") WHERE "binding_invitations"."revoked_at" is null and "binding_invitations"."accepted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "binding_periods_one_open" ON "binding_periods" USING btree ("space_id") WHERE "binding_periods"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "spaces_user_high" ON "spaces" USING btree ("user_high");