CREATE TABLE `invites` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`couple_do_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `invites_couple_idx` ON `invites` (`couple_do_id`);