ALTER TABLE "servers" ALTER COLUMN "disk_quota_bytes" SET DATA TYPE bigint USING "disk_quota_bytes"::bigint;--> statement-breakpoint
ALTER TABLE "crash_reports" ALTER COLUMN "size_bytes" SET DATA TYPE bigint USING "size_bytes"::bigint;--> statement-breakpoint
ALTER TABLE "library_files" ALTER COLUMN "size_bytes" SET DATA TYPE bigint USING "size_bytes"::bigint;--> statement-breakpoint
ALTER TABLE "backups" ALTER COLUMN "size_bytes" SET DATA TYPE bigint USING "size_bytes"::bigint;--> statement-breakpoint
ALTER TABLE "blueprints" ALTER COLUMN "size_bytes" SET DATA TYPE bigint USING "size_bytes"::bigint;--> statement-breakpoint
ALTER TABLE "storage_index" ALTER COLUMN "size_bytes" SET DATA TYPE bigint USING "size_bytes"::bigint;--> statement-breakpoint
ALTER TABLE "storage_snapshots" ALTER COLUMN "total_bytes" SET DATA TYPE bigint USING "total_bytes"::bigint;