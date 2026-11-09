CREATE TABLE "mail_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer NOT NULL,
	"smtp_security" text NOT NULL,
	"smtp_username" text DEFAULT '' NOT NULL,
	"smtp_password_sealed" text,
	"sender_name" text NOT NULL,
	"sender_email" text NOT NULL,
	"reply_to" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_recipient" text,
	"last_test_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_settings_singleton" CHECK ("mail_settings"."id" = 1),
	CONSTRAINT "mail_settings_port" CHECK ("mail_settings"."smtp_port" BETWEEN 1 AND 65535),
	CONSTRAINT "mail_settings_security" CHECK ("mail_settings"."smtp_security" IN ('STARTTLS', 'TLS'))
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "delivery_status" text DEFAULT 'CAPTURED' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "delivery_error" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD CONSTRAINT "mail_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_outbox_delivery_idx" ON "email_outbox" USING btree ("delivery_status","created_at");--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_delivery_status" CHECK ("email_outbox"."delivery_status" IN ('CAPTURED', 'QUEUED', 'SENT', 'FAILED'));