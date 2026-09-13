CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"wallet_address" text NOT NULL,
	"side" text NOT NULL,
	"amount_raw" text NOT NULL,
	"price_usd" double precision,
	"tx_hash" text NOT NULL,
	"log_index" text NOT NULL,
	"block_or_slot" text NOT NULL,
	"trade_timestamp" timestamp with time zone NOT NULL,
	"is_system_wallet" boolean DEFAULT false NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trades_tx_hash_log_index_unique" ON "trades" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "trades_token_id_idx" ON "trades" USING btree ("token_id");