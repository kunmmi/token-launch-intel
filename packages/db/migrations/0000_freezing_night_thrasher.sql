CREATE TABLE "chains" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_system_addresses" (
	"venue_id" text NOT NULL,
	"address" text NOT NULL,
	"label" text NOT NULL,
	"reason" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venue_system_addresses_venue_id_address_pk" PRIMARY KEY("venue_id","address")
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"chain_id" text NOT NULL,
	"registry_status" text DEFAULT 'watching' NOT NULL,
	"has_hosted_api" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_addresses" (
	"creator_id" uuid NOT NULL,
	"chain_id" text NOT NULL,
	"address" text NOT NULL,
	"is_self_attested" boolean DEFAULT false NOT NULL,
	"is_signature_verified" boolean DEFAULT false NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_addresses_chain_id_address_pk" PRIMARY KEY("chain_id","address")
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "launches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"creator_id" uuid,
	"creator_address" text NOT NULL,
	"launch_timestamp" timestamp with time zone NOT NULL,
	"launch_tx_hash" text NOT NULL,
	"launch_block_or_slot" text NOT NULL,
	"venue_schema_version" text NOT NULL,
	"graduation_state" text DEFAULT 'NOT_GRADUATED' NOT NULL,
	"raw_graduation_progress" double precision DEFAULT 0 NOT NULL,
	"normalized_graduation_progress_pct" double precision DEFAULT 0 NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" text NOT NULL,
	"address" text NOT NULL,
	"venue_id" text NOT NULL,
	"name" text NOT NULL,
	"ticker" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "venue_system_addresses" ADD CONSTRAINT "venue_system_addresses_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_addresses" ADD CONSTRAINT "creator_addresses_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "launches_token_id_unique" ON "launches" USING btree ("token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_chain_address_unique" ON "tokens" USING btree ("chain_id","address");