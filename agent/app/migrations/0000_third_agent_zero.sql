CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`at` integer NOT NULL,
	`message` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `logs_session_idx` ON `logs` (`session_id`,`id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`sdk_session_id` text,
	`created_at` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`permission_mode` text DEFAULT 'default' NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`items` text DEFAULT '[]' NOT NULL
);
