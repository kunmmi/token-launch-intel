CREATE TABLE "holder_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_supply_raw" text NOT NULL,
	"circulating_supply_raw" text NOT NULL,
	"top_accounts" jsonb NOT NULL,
	"visible_holder_count" integer NOT NULL,
	"top10_concentration_pct" double precision
);
--> statement-breakpoint
ALTER TABLE "holder_snapshots" ADD CONSTRAINT "holder_snapshots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holder_snapshots_token_id_idx" ON "holder_snapshots" USING btree ("token_id");