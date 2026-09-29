CREATE TABLE "content_import_overrides" (
	"id" text PRIMARY KEY,
	"import_id" text NOT NULL,
	"rel_path" text NOT NULL,
	"sha256" text NOT NULL,
	"had_original" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_imports" (
	"id" text PRIMARY KEY,
	"server_id" text NOT NULL,
	"format" text NOT NULL,
	"name" text NOT NULL,
	"version" text,
	"actor" text NOT NULL,
	"created_at" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_content" ADD COLUMN "import_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "content_import_overrides_import_path" ON "content_import_overrides" ("import_id","rel_path");--> statement-breakpoint
CREATE INDEX "idx_content_imports_server" ON "content_imports" ("server_id");--> statement-breakpoint
ALTER TABLE "content_import_overrides" ADD CONSTRAINT "content_import_overrides_import_id_content_imports_id_fkey" FOREIGN KEY ("import_id") REFERENCES "content_imports"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "content_imports" ADD CONSTRAINT "content_imports_server_id_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE;