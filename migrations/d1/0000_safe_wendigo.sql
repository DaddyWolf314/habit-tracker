CREATE TABLE `credentials` (
	`credential_hash` text PRIMARY KEY NOT NULL,
	`identity_hash` text NOT NULL,
	`couple_do_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `credentials_identity_idx` ON `credentials` (`identity_hash`);