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
	// v10 — the Agreement corpus (#121, ADR 0006): the couple's own terms, as
	// distinct from the engine rules that share the word. Shaped after `rules` /
	// `rule_versions` because it carries the same guarantee — a stable identity
	// plus append-only effective-dated versions, so editing a term appends rather
	// than overwrites and a citation can still resolve what was in force when the
	// act happened.
	//
	// Two departures from the rules tables, both deliberate:
	//   - `agreement_versions` carries `name` alongside the prose, so renaming is
	//     not retroactive: a citation renders what the term was called at the time.
	//   - `kind` lives on the identity row and is never versioned. A versioned kind
	//     would be an escalation path, since re-kinding is how you would otherwise
	//     author in the other role's category.
	//
	// `agreement_kinds` is what makes "the sub alone writes limits" structural
	// rather than conventional; nothing is seeded here (kinds arrive with the
	// template pack, entries are the couple's own — a default term is one nobody
	// consented to but everybody has).
	[
		`CREATE TABLE IF NOT EXISTS agreement_kinds (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			author_permission TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS agreements (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS agreement_versions (
			agreement_id TEXT NOT NULL,
			effective_from INTEGER NOT NULL,
			name TEXT NOT NULL,
			text TEXT NOT NULL,
			review_cadence_days INTEGER,
			retired INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (agreement_id, effective_from)
		)`,
		`CREATE INDEX IF NOT EXISTS agreements_kind_idx ON agreements (kind)`,
	],
	// v11 — a rule carries a user-authored name (#150, ADR 0009). It lands on
	// `rule_versions`, not on the identity row, for the reason the v10 comment
	// gives for `agreement_versions.name`, and more sharply: rule history is
	// *displayed*, so a name on the identity row would retroactively rewrite what
	// a past revision row and a past change notice said the rule was called.
	//
	// Nullable rather than `NOT NULL DEFAULT ''`: "this version predates naming" is
	// a real state, and the read path renders it already — `ruleName()` falls back
	// to a de-slugged id. A blank string would be indistinguishable from a name the
	// couple typed and then cleared.
	//
	// The backfill covers only *custom* rules, seeding each from its de-slugged id
	// (`custom-late-check-in` → "late check in"). That is the display strategy #150
	// rejected, and it is still right as a one-time seed: what it writes is an
	// ordinary name the couple can correct, where a permanent de-slug-on-read could
	// never be corrected, because the id it derives from is immutable by design.
	//
	// Pack rules are deliberately left null. Only the shipped pack knows that R7 is
	// "Infraction resets the clock", so `ensureRulePackSeeded` fills those from
	// `rules.json` — rather than this file freezing a copy of the pack's names that
	// would then quietly diverge from it, since a rename does not reconcile.
	[
		`ALTER TABLE rule_versions ADD COLUMN name TEXT`,
		`UPDATE rule_versions
			SET name = REPLACE(REPLACE(
				CASE WHEN rule_id LIKE 'custom-%' THEN SUBSTR(rule_id, 8) ELSE rule_id END,
				'-', ' '), '_', ' ')
			WHERE rule_id NOT GLOB 'R[0-9]*'`,
	],
	// v12 — Agreement kinds freeze against the pack (#159, ADR 0010). The v10 table
	// shipped without the adoption state `rules` has carried since v8/v9, so
	// `seedAgreementKinds` upserted `author_permission` unconditionally: a couple who
	// tightened a kind by hand — the only workaround for #129's hole — had that
	// tightening silently reset by the next kinds ship. A permission regression
	// delivered as an upgrade, on the one setting whose whole job is safety.
	//
	// This is a precondition for the subject/scope change, not a related cleanup.
	// ADR 0010 makes `author_scope` immutable because flipping a scope converts every
	// existing entry in one write — and an unconditional pack upsert *is* that flip,
	// performed by the pack. A scope landing on a clobberable table would leave the
	// invariant it rests on as decoration.
	//
	// Mirrors v9's `rules.upstream_changed` in shape and meaning: `adopted` is set by
	// `updateAgreementKind`, and `upstream_changed` is the flag (not the audit row)
	// that drives the "new default" badge — cleared by the couple's next edit, or by
	// a bump that finds no diff.
	//
	// **No backfill**, deliberately. A past edit is recoverable (`edit_kind` writes an
	// `agreement_edit_kind` row to `consent_history`), but no couple has authored an
	// Agreement or edited a kind, so there is nothing to reconstruct and `DEFAULT 0`
	// is exact rather than a guess — ADR 0010, "build the mechanisms, skip the
	// archaeology".
	[
		`ALTER TABLE agreement_kinds ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE agreement_kinds ADD COLUMN upstream_changed INTEGER NOT NULL DEFAULT 0`,
	],
	// v13 — an Agreement has a subject, and its kind an author scope (#160, ADR
	// 0010). Authorship was by role, and a role list cannot say what the corpus
	// needs: `limit` (`[sub, switch]`) let either partner move the other's boundary
	// in a switch+sub *and* a switch+switch couple, while `protocol` (`[dom, switch]`)
	// let the switch in a dom+switch couple rewrite the obligations binding
	// themselves. Both are the same defect — a kind whose author list resolves to
	// more than one member — pointing in opposite directions.
	//
	// `agreements.subject` is nullable and mirrors `events.subject`: a member id,
	// naming who the term is *about*. It sits on the identity row and is never
	// written twice, because a versioned subject would let a revision move a limit to
	// its author and own it outright.
	//
	// **The scope backfill is deliberately frozen here**, which is the opposite of
	// the call ADR 0009 made for rule names — and for the opposite reason. A name
	// does not reconcile, so freezing one would strand it the first time the pack
	// reworded it; a scope may *never* change (ADR 0010 makes it immutable, since
	// flipping one converts every existing entry in a single write), so there is
	// nothing for a frozen value to diverge from. `seedAgreementKinds` writes a scope
	// on insert only, never on a bump, so this is the one place an existing kind can
	// get one.
	//
	// The subject backfill reads `author_scope`, so it has to run after it, and reads
	// `agreement.create` from the audit log — which is exact for who *typed* an
	// entry. Nothing prunes `audit_log`. No couple has authored an Agreement, so in
	// practice this touches nothing; it is kept because it costs ten lines and a
	// later reader should see what the intended derivation was (ADR 0010, "build the
	// mechanisms, skip the archaeology").
	[
		`ALTER TABLE agreement_kinds ADD COLUMN author_scope TEXT NOT NULL DEFAULT 'unscoped'`,
		`UPDATE agreement_kinds SET author_scope = 'counterpart'
			WHERE id IN ('protocol', 'ritual')`,
		`UPDATE agreement_kinds SET author_scope = 'subject' WHERE id = 'limit'`,
		`ALTER TABLE agreements ADD COLUMN subject TEXT`,
		// A subject-scoped term is its creator's own — "no marks above the collar" is
		// a fact about the speaker's body.
		`UPDATE agreements SET subject = (
				SELECT actor FROM audit_log
					WHERE action = 'agreement.create' AND target = agreements.id
					ORDER BY at LIMIT 1
			)
			WHERE kind IN (SELECT id FROM agreement_kinds WHERE author_scope = 'subject')`,
		// A counterpart-scoped term is about the other member: the dom writes the
		// protocol, the sub is bound by it.
		`UPDATE agreements SET subject = (
				SELECT m.id FROM members m
					WHERE m.id != (
						SELECT actor FROM audit_log
							WHERE action = 'agreement.create' AND target = agreements.id
							ORDER BY at LIMIT 1
					)
					LIMIT 1
			)
			WHERE kind IN (SELECT id FROM agreement_kinds WHERE author_scope = 'counterpart')`,
	],
	// v14 — counter definitions become effective-dated (ADR 0013). The third
	// instance of the identity-plus-append-only-versions shape, after
	// `rule_versions` (v8) and `agreement_versions` (v10), and shaped after v8:
	// `counters.definition` is retained as a mirror of the latest version, kept in
	// step by the single write path, so only the reads that actually resolve a
	// moment — the rollover fold and the rebuild replay — go through the versions.
	//
	// What it unblocks: streak counters were the one projection `rebuildCounters`
	// preserved despite replay being able to reconstruct it (ADR 0012). A fold is
	// `target met? +1 : 0` over the target's end-of-period value, and both are
	// derivable — but the *target* lives on the definition, so re-deriving without
	// versions would score every past period against whatever the target says
	// today. That is the retroactive re-scoring ADR 0002 exists to prevent.
	//
	// Everything but the `id` versions, for the reason ADR 0009 gave for rule
	// names: a counter's name is displayed against its own history, so a name on
	// the identity row would retroactively rewrite what a past trace row said the
	// counter was called.
	//
	// Backfill: one version per counter, effective from 0, carrying today's
	// definition — byte-for-byte the v8 rule backfill. It cannot recover targets
	// that changed *before* this migration, because nothing recorded them; the set
	// of counters that affects is empty (no couple has edited one, and an unedited
	// pack counter re-derives identically). Build the mechanism, skip the
	// archaeology.
	[
		`CREATE TABLE IF NOT EXISTS counter_versions (
			counter_id TEXT NOT NULL,
			effective_from INTEGER NOT NULL,
			definition TEXT NOT NULL,
			PRIMARY KEY (counter_id, effective_from)
		)`,
		`INSERT INTO counter_versions (counter_id, effective_from, definition)
			SELECT id, 0, definition FROM counters`,
	],
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
