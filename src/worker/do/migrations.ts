/**
 * Per-DO schema migrations (handoff §3.5). Each couple's Durable Object owns an
 * embedded SQLite database; there is no global query escape hatch, so schema
 * changes run lazily inside each DO on wake. Migrations are an ordered list of
 * idempotent steps, version-stamped in the DO's own storage.
 *
 * Append a new array element to evolve the schema — never edit an existing one.
 * Index `i` corresponds to schema version `i + 1`.
 */
export const DO_MIGRATIONS: string[][] = [
	// v1 — Phase 0 skeleton. Tables the later phases fill in; created now so the
	// migration runner and per-DO versioning are exercised from day one.
	[
		// Couple-level settings (roles confirmed, pause-everything state, etc.).
		`CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
		// Members bound into this couple. Identity/device auth lands in Phase 1.
		`CREATE TABLE IF NOT EXISTS members (
			id TEXT PRIMARY KEY,
			identity_hash TEXT NOT NULL,
			role TEXT,
			joined_at INTEGER NOT NULL,
			UNIQUE (identity_hash)
		)`,
		// Per-device tokens (revocable). Mirror of the routing-layer credential.
		`CREATE TABLE IF NOT EXISTS devices (
			token_hash TEXT PRIMARY KEY,
			member_id TEXT NOT NULL,
			label TEXT,
			created_at INTEGER NOT NULL,
			revoked_at INTEGER
		)`,
		// Append-only event log — the source of truth (handoff §4.1).
		`CREATE TABLE IF NOT EXISTS events (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			actor TEXT NOT NULL,
			subject TEXT,
			occurred_at INTEGER NOT NULL,
			logged_at INTEGER NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}',
			note TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS events_occurred_idx ON events (occurred_at)`,
		// Rulings and corrections against events (handoff §4.2). Never deletes.
		`CREATE TABLE IF NOT EXISTS amendments (
			id TEXT PRIMARY KEY,
			target_event_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			actor TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			patch TEXT,
			note TEXT,
			supersedes TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS amendments_target_idx ON amendments (target_event_id)`,
		// Per-couple event-type schema set (starter seven + custom).
		`CREATE TABLE IF NOT EXISTS event_types (
			id TEXT PRIMARY KEY,
			definition TEXT NOT NULL
		)`,
		// Installed rules (R1–R18 template + custom).
		`CREATE TABLE IF NOT EXISTS rules (
			id TEXT PRIMARY KEY,
			definition TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1
		)`,
		// Materialized projections — caches, rebuildable by event replay.
		`CREATE TABLE IF NOT EXISTS counters (
			id TEXT PRIMARY KEY,
			definition TEXT NOT NULL,
			value INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER
		)`,
		`CREATE TABLE IF NOT EXISTS timers (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			definition TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT '{}',
			status TEXT,
			opened_at INTEGER,
			closed_at INTEGER
		)`,
		// Trace / transparency: every projection change records its cause.
		`CREATE TABLE IF NOT EXISTS trace (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at INTEGER NOT NULL,
			caused_by_event TEXT,
			caused_by_rule TEXT,
			projection TEXT,
			detail TEXT
		)`,
		// Internal schedule feeding the DO's single alarm (handoff §3.2).
		`CREATE TABLE IF NOT EXISTS schedule (
			id TEXT PRIMARY KEY,
			next_fire_at INTEGER NOT NULL,
			kind TEXT NOT NULL,
			payload TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS schedule_fire_idx ON schedule (next_fire_at)`,
	],
	// v2 — Phase 1 #14: an opaque per-device id so the "your devices" panel can
	// list and revoke devices without ever exposing the token hash.
	[
		`ALTER TABLE devices ADD COLUMN device_id TEXT`,
		`CREATE UNIQUE INDEX IF NOT EXISTS devices_device_id_idx ON devices (device_id)`,
	],
	// v3 — Phase 1 #16: the append-only agreement/consent history. Mutual role
	// confirmation writes the first entry; later agreements append here too.
	[
		`CREATE TABLE IF NOT EXISTS consent_history (
			id TEXT PRIMARY KEY,
			at INTEGER NOT NULL,
			kind TEXT NOT NULL,
			detail TEXT
		)`,
	],
	// v4 — Phase 4 #31: elapsed-since anchors. A materialized projection (a cache
	// rebuildable by replay), each anchor is a single `since` reset timestamp;
	// null until a rule effect first resets it. The live "days since" display is
	// derived from `since` on read/tick.
	[
		`CREATE TABLE IF NOT EXISTS anchors (
			id TEXT PRIMARY KEY,
			since INTEGER
		)`,
	],
	// v5 — Phase 5: the Trace ledger. Dedicated columns for the amendment that
	// unlocked an effect and the actor behind a dom command, so a trace row's cause
	// is fully derivable from columns — `caused_by_rule` stops doubling as a
	// 'system_job'/'dom_command' sentinel and now holds only real rule ids. Nullable
	// adds; any pre-existing rows read back as having neither (cause degrades cleanly).
	[
		`ALTER TABLE trace ADD COLUMN caused_by_amendment TEXT`,
		`ALTER TABLE trace ADD COLUMN actor TEXT`,
	],
	// v6 — Phase 6 #44: the support-introspection audit log. Every access to the
	// "why did this projection change" endpoint appends a row here, inside the
	// couple's own DO — so a support read is transparent relationship data, never
	// a silent backdoor. There is no global query escape hatch: this log only ever
	// records reads of this one couple, and only members of it can read the log.
	[
		`CREATE TABLE IF NOT EXISTS audit_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at INTEGER NOT NULL,
			actor TEXT NOT NULL,
			action TEXT NOT NULL,
			target TEXT
		)`,
	],
	// v7 — Journaling #56 (ADR 0001): a journal entry's author-chosen visibility.
	// A first-class, persisted column (not a metadata slot) so the read model can
	// filter secret/sealed entries without decoding prose. Defaults to 'shared', so
	// every pre-existing event — and every non-journaling event — reads back shared,
	// preserving the "everything in the log is shared" invariant for the whole
	// accountability spine.
	[`ALTER TABLE events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'`],
	// v8 — Rules become user-editable and effective-dated (#64, ADR 0002). A rule
	// keeps its stable identity row and gains provenance: `origin` (a shipped `R#`
	// pack rule vs. a custom one) and `adopted` (a pack rule the couple has edited,
	// frozen against future pack overwrites). Its definition history moves to an
	// append-only `rule_versions` table keyed by `effective_from` (log-time), so an
	// edit appends a version and replay picks the version in force at each event's
	// log-time. Backfill: every existing rule becomes a single version effective
	// from 0 — so replay before any edit is byte-for-byte unchanged — with origin
	// derived from the `R#` namespace. `rules.definition`/`enabled` are retained as
	// a mirror of the latest version (kept in step by the single write path).
	[
		`ALTER TABLE rules ADD COLUMN origin TEXT NOT NULL DEFAULT 'custom'`,
		`ALTER TABLE rules ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0`,
		`CREATE TABLE IF NOT EXISTS rule_versions (
			rule_id TEXT NOT NULL,
			effective_from INTEGER NOT NULL,
			definition TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (rule_id, effective_from)
		)`,
		`INSERT INTO rule_versions (rule_id, effective_from, definition, enabled)
			SELECT id, 0, definition, enabled FROM rules`,
		`UPDATE rules SET origin = CASE WHEN id GLOB 'R[0-9]*' THEN 'pack' ELSE 'custom' END`,
	],
	// v9 — #64 user story 33: an adopted rule whose shipped default has moved on.
	// Pack reconciliation sets this when a bump finds a new default for a rule the
	// couple has adopted (and so will never overwrite); the rules screen surfaces
	// it as a "new default" notice, and the flag clears when the couple next edits
	// the rule — they've seen the new default and made their choice.
	[`ALTER TABLE rules ADD COLUMN upstream_changed INTEGER NOT NULL DEFAULT 0`],
];

const VERSION_KEY = "schema_version";

/**
 * Applies any migrations newer than the DO's stored schema version. Idempotent:
 * safe to call on every wake. Returns the resulting schema version.
 */
export function runMigrations(sql: SqlStorage): number {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	);

	const row = sql
		.exec<{ value: string }>(
			`SELECT value FROM _meta WHERE key = ?`,
			VERSION_KEY,
		)
		.toArray()[0];
	let current = row ? Number(row.value) : 0;

	for (let version = current; version < DO_MIGRATIONS.length; version++) {
		for (const statement of DO_MIGRATIONS[version]) {
			sql.exec(statement);
		}
		current = version + 1;
	}

	sql.exec(
		`INSERT INTO _meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		VERSION_KEY,
		String(current),
	);

	return current;
}
