CREATE TABLE `server_content` (
	`id` text PRIMARY KEY,
	`server_id` text NOT NULL,
	`library_id` text,
	`kind` text NOT NULL,
	`managed_by` text NOT NULL,
	`name` text NOT NULL,
	`filename` text NOT NULL,
	`version` text,
	`icon_url` text,
	`icon_rel_path` text,
	`enabled` integer DEFAULT true NOT NULL,
	`installed_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_server_content_server_id_servers_id_fk` FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `server_packs` (
	`server_id` text PRIMARY KEY,
	`platform` text NOT NULL,
	`project_ref` text NOT NULL,
	`project_name` text NOT NULL,
	`pinned_version_id` text NOT NULL,
	`pinned_version_name` text NOT NULL,
	`previous_version_id` text,
	`previous_version_name` text,
	`installed_at` text DEFAULT (datetime('now')) NOT NULL,
	`max_java_version` integer,
	`channel` text,
	CONSTRAINT `fk_server_packs_server_id_servers_id_fk` FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY,
	`display_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`icon` text DEFAULT 'grass' NOT NULL,
	`accent` text DEFAULT '#3fa62b' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`mc_version` text DEFAULT 'LATEST' NOT NULL,
	`java_tag` text DEFAULT '' NOT NULL,
	`env_json` text DEFAULT '{}' NOT NULL,
	`port_game` integer NOT NULL,
	`port_rcon` integer NOT NULL,
	`port_query` integer,
	`port_bedrock` integer,
	`rcon_password_cipher` text NOT NULL,
	`heap_mb` integer NOT NULL,
	`container_memory_mb` integer NOT NULL,
	`container_swap_mb` integer DEFAULT 0 NOT NULL,
	`cpus` real DEFAULT 0 NOT NULL,
	`disk_quota_bytes` integer DEFAULT 0 NOT NULL,
	`quota_strict` integer DEFAULT false NOT NULL,
	`update_policy` text DEFAULT 'manual' NOT NULL,
	`auto_start` integer DEFAULT false NOT NULL,
	`auto_restart` integer DEFAULT true NOT NULL,
	`container_id` text,
	`pending_recreate` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'stopped' NOT NULL,
	`last_started_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`deleted_at` text,
	`console_label` text,
	`container_name` text,
	`network_name` text,
	`extra_ports_json` text DEFAULT '[]' NOT NULL,
	`extra_binds_json` text DEFAULT '[]' NOT NULL,
	`router_hostname` text,
	`router_auto_scale` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`sid` text PRIMARY KEY,
	`data_json` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_server_permissions` (
	`user_id` text NOT NULL,
	`server_id` text NOT NULL,
	`perms` text DEFAULT 'view' NOT NULL,
	CONSTRAINT `user_server_permissions_pk` PRIMARY KEY(`user_id`, `server_id`),
	CONSTRAINT `fk_user_server_permissions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`username` text NOT NULL UNIQUE,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'admin' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`totp_secret` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`totp_backup_codes_json` text,
	`totp_last_step` integer
);
--> statement-breakpoint
CREATE TABLE `crash_reports` (
	`id` text PRIMARY KEY,
	`server_id` text NOT NULL,
	`filename` text NOT NULL,
	`file_mtime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`exception` text DEFAULT '' NOT NULL,
	`suspected_json` text DEFAULT '[]' NOT NULL,
	`event_id` integer,
	`viewed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_crash_reports_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`server_id` text,
	`actor` text NOT NULL,
	`type` text NOT NULL,
	`summary` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`log_excerpt_path` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `player_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`server_id` text NOT NULL,
	`ts` text NOT NULL,
	`type` text NOT NULL,
	`player` text DEFAULT '' NOT NULL,
	`target` text DEFAULT '' NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`raw` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `player_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`server_id` text NOT NULL,
	`player` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE TABLE `player_stat_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`server_id` text NOT NULL,
	`uuid` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`ts` text DEFAULT (datetime('now')) NOT NULL,
	`stats_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `library_files` (
	`id` text PRIMARY KEY,
	`category` text NOT NULL,
	`name` text NOT NULL,
	`filename` text NOT NULL,
	`rel_path` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`source_url` text,
	`platform` text,
	`project_id` text,
	`file_id` text,
	`version` text,
	`mc_versions_json` text DEFAULT '[]' NOT NULL,
	`loaders_json` text DEFAULT '[]' NOT NULL,
	`icon_url` text,
	`icon_rel_path` text,
	`world_source` text,
	`world_flavor` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_command_settings` (
	`server_id` text PRIMARY KEY,
	`prefix` text DEFAULT '!' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_commands` (
	`id` text PRIMARY KEY,
	`server_id` text NOT NULL,
	`trigger` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`action` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`permission` text DEFAULT 'everyone' NOT NULL,
	`cooldown_sec` integer DEFAULT 30 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`msg_pending` text,
	`msg_success` text,
	`msg_failure` text
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY,
	`server_id` text,
	`task_type` text NOT NULL,
	`cron` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_schedules_server_id_servers_id_fk` FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY,
	`server_id` text NOT NULL,
	`filename` text NOT NULL,
	`rel_path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text,
	`reason` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_backups_server_id_servers_id_fk` FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `blueprints` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`filename` text NOT NULL,
	`rel_path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`manifest_json` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `integrations` (
	`server_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`config_cipher` text,
	`config_json` text DEFAULT '{}' NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `integrations_pk` PRIMARY KEY(`server_id`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `api_cache` (
	`key` text PRIMARY KEY,
	`value_json` text NOT NULL,
	`fetched_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`provider` text PRIMARY KEY,
	`key_cipher` text NOT NULL,
	`added_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_tested_at` text,
	`last_test_ok` integer
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_index` (
	`rel_path` text PRIMARY KEY,
	`size_bytes` integer NOT NULL,
	`file_count` integer NOT NULL,
	`scanned_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`total_bytes` integer NOT NULL,
	`per_server_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `update_checks` (
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`current_version` text NOT NULL,
	`latest_version` text,
	`latest_name` text,
	`changelog_url` text,
	`checked_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `update_checks_pk` PRIMARY KEY(`subject_type`, `subject_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_content_server_filename` ON `server_content` (`server_id`,`filename`);--> statement-breakpoint
CREATE UNIQUE INDEX `crash_reports_server_filename` ON `crash_reports` (`server_id`,`filename`);--> statement-breakpoint
CREATE INDEX `idx_events_created` ON `events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_events_server` ON `events` (`server_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_events_type` ON `events` (`type`);--> statement-breakpoint
CREATE INDEX `idx_pevents_player` ON `player_events` (`player`);--> statement-breakpoint
CREATE INDEX `idx_pevents_server_ts` ON `player_events` (`server_id`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_pevents_type` ON `player_events` (`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sessions_player` ON `player_sessions` (`server_id`,`player`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_statsnap` ON `player_stat_snapshots` (`server_id`,`uuid`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_library_cat` ON `library_files` (`category`);--> statement-breakpoint
CREATE INDEX `idx_library_sha` ON `library_files` (`sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_library_sha_cat` ON `library_files` (`sha256`,`category`);--> statement-breakpoint
CREATE INDEX `idx_chatcmd_server` ON `chat_commands` (`server_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_commands_server_trigger` ON `chat_commands` (`server_id`,`trigger`);--> statement-breakpoint
CREATE INDEX `idx_backups_server` ON `backups` (`server_id`,`created_at`);