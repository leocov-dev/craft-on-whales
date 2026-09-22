CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY,
	`token_hash` text NOT NULL UNIQUE,
	`label` text NOT NULL,
	`created_by` text NOT NULL,
	`server_ids_json` text,
	`expires_at` text,
	`revoked` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_used_at` text
);
