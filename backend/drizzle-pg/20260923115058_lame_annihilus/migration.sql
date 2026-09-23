CREATE TABLE "player_notes" (
	"id" text PRIMARY KEY,
	"server_id" text NOT NULL,
	"uuid" text NOT NULL,
	"name" text NOT NULL,
	"note" text NOT NULL,
	"author" text NOT NULL,
	"created_at" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_player_notes_lookup" ON "player_notes" ("server_id","uuid");