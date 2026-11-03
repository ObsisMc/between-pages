CREATE TABLE "mascot_pokes" (
	"period_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"pokes" integer DEFAULT 0 NOT NULL,
	"pets" integer DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"poke_sent_at" timestamp with time zone,
	"pet_sent_at" timestamp with time zone,
	CONSTRAINT "mascot_pokes_period_id_recipient_id_pk" PRIMARY KEY("period_id","recipient_id"),
	CONSTRAINT "mascot_pokes_counts" CHECK ("mascot_pokes"."pokes" >= 0 and "mascot_pokes"."pets" >= 0)
);
--> statement-breakpoint
ALTER TABLE "mascot_pokes" ADD CONSTRAINT "mascot_pokes_period_id_binding_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."binding_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mascot_pokes" ADD CONSTRAINT "mascot_pokes_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;