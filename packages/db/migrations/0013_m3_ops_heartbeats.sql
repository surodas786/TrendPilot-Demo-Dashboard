CREATE TABLE "service_heartbeats" (
	"service" text NOT NULL,
	"instance" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stopped_at" timestamp with time zone,
	CONSTRAINT "service_heartbeats_service_instance_pk" PRIMARY KEY("service","instance")
);
