ALTER TABLE "binding_invitations" ALTER COLUMN "token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "binding_invitations" ADD COLUMN "recipient_email" text;--> statement-breakpoint
ALTER TABLE "binding_invitations" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "binding_invitations_recipient" ON "binding_invitations" USING btree ("recipient_email") WHERE "binding_invitations"."revoked_at" is null and "binding_invitations"."accepted_at" is null;--> statement-breakpoint
ALTER TABLE "binding_invitations" ADD CONSTRAINT "binding_invitations_one_way" CHECK (num_nulls("binding_invitations"."token_hash", "binding_invitations"."recipient_email") = 1);--> statement-breakpoint
ALTER TABLE "binding_invitations" ADD CONSTRAINT "binding_invitations_dismiss_directed" CHECK ("binding_invitations"."dismissed_at" is null or "binding_invitations"."recipient_email" is not null);