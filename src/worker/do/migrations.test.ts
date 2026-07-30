import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DO_MIGRATIONS, runMigrations } from "./migrations.ts";

/**
 * The per-DO migration runner, exercised against a real SQLite database.
 *
 * Migrations run **lazily inside each couple's DO on wake**, which means the two
 * cases that matter are structurally different and only one of them is ever
 * exercised in development: a fresh DO applies the whole list at once, while a
 * long-lived DO applies only the tail — against tables that already hold the
 * couple's data. A statement that is fine on an empty schema and wrong on a
 * populated one (#150's `name` backfill is exactly that shape) shows up in the
 * second case and nowhere else, on a database with no global query escape hatch
 * to repair it through.
 *
 * `better-sqlite3` is the same engine the DO embeds, so the SQL here is the SQL
 * that will run. The shim below is the whole of the Workers `SqlStorage` surface
 * `runMigrations` touches.
 */

/** The slice of `SqlStorage` the migration runner uses, over better-sqlite3. */
function sqlStorage(db: Database.Database): SqlStorage {
	return {
		exec(query: string, ...bindings: unknown[]) {
			const statement = db.prepare(query);
			// better-sqlite3 refuses `.all()` on a statement that returns no columns,
			// which is most of a migration; `.run()` is the path for those.
			const rows = statement.reader ? statement.all(...bindings) : [];
			if (!statement.reader) statement.run(...bindings);
			return { toArray: () => rows } as unknown as SqlStorageCursor<
				Record<string, SqlStorageValue>
			>;
		},
	} as SqlStorage;
}

/** A DO that stopped at `version` — the state a couple paired before v11 is in. */
function doAtVersion(version: number): Database.Database {
	const db = new Database(":memory:");
	const sql = sqlStorage(db);
	for (const statement of DO_MIGRATIONS.slice(0, version).flat()) {
		sql.exec(statement);
	}
	sql.exec(
		`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	);
	sql.exec(
		`INSERT INTO _meta (key, value) VALUES ('schema_version', ?)`,
		String(version),
	);
	return db;
}
function columns(db: Database.Database, table: string): string[] {
	return db
		.prepare(`SELECT name FROM pragma_table_info(?)`)
		.all(table)
		.map((row) => (row as { name: string }).name);
}

describe("runMigrations", () => {
	it("brings a fresh DO to the newest version and stamps it", () => {
		const db = new Database(":memory:");
		expect(runMigrations(sqlStorage(db))).toBe(DO_MIGRATIONS.length);
		expect(columns(db, "rule_versions")).toContain("name");
	});

	it("is a no-op on a DO already at the newest version", () => {
		const db = new Database(":memory:");
		runMigrations(sqlStorage(db));
		// The guard is what makes waking safe: re-running v11 would fail outright,
		// because `ALTER TABLE … ADD COLUMN name` is not idempotent in SQLite.
		expect(() => runMigrations(sqlStorage(db))).not.toThrow();
		expect(runMigrations(sqlStorage(db))).toBe(DO_MIGRATIONS.length);
	});
});

/**
 * v11 — a rule carries a user-authored name (#150, ADR 0009).
 */
describe("v11 rule names", () => {
	/** A DO paired before v11, holding one pack rule and one custom rule. */
	function preV11(): Database.Database {
		const db = doAtVersion(10);
		const definition = JSON.stringify({
			condition: { type: "check_in", metadata: {} },
			effects: [{ verb: "increment_counter", counter: "check_ins_week" }],
		});
		const insert = db.prepare(
			`INSERT INTO rule_versions (rule_id, effective_from, definition, enabled)
				VALUES (?, ?, ?, 1)`,
		);
		insert.run("R7", 0, definition);
		insert.run("custom-late-check-in", 0, definition);
		// Two revisions of the same custom rule: the backfill has to reach every
		// version, not just the current one, or the history list renders half ids.
		insert.run("custom-late-check-in", 500, definition);
		return db;
	}

	function nameOf(db: Database.Database, id: string): (string | null)[] {
		return db
			.prepare(
				`SELECT name FROM rule_versions WHERE rule_id = ? ORDER BY effective_from`,
			)
			.all(id)
			.map((row) => (row as { name: string | null }).name);
	}

	it("adds the column to a DO that already has rules", () => {
		const db = preV11();
		expect(columns(db, "rule_versions")).not.toContain("name");
		runMigrations(sqlStorage(db));
		expect(columns(db, "rule_versions")).toContain("name");
	});

	it("seeds every revision of a custom rule from its de-slugged id", () => {
		const db = preV11();
		runMigrations(sqlStorage(db));
		expect(nameOf(db, "custom-late-check-in")).toEqual([
			"late check in",
			"late check in",
		]);
	});

	// Only the shipped pack knows what R7 is called, so the migration leaves it
	// null and `ensureRulePackSeeded` fills it from `rules.json`. Freezing the
	// pack's names into a migration would strand them the first time the pack
	// reworded one, since a rename does not reconcile (ADR 0009).
	it("leaves pack rules null for the pack itself to name", () => {
		const db = preV11();
		runMigrations(sqlStorage(db));
		expect(nameOf(db, "R7")).toEqual([null]);
	});

	it("keeps the couple's data intact", () => {
		const db = preV11();
		runMigrations(sqlStorage(db));
		const row = db
			.prepare(
				`SELECT definition, enabled FROM rule_versions WHERE rule_id = ?`,
			)
			.get("R7") as { definition: string; enabled: number };
		expect(JSON.parse(row.definition).condition.type).toBe("check_in");
		expect(row.enabled).toBe(1);
	});
});

/**
 * v12 — Agreement kinds freeze against the pack (#159, ADR 0010).
 *
 * The populated case is the one that matters: a couple paired before v12 already
 * holds seeded kinds, one of which they may have tightened by hand. The migration
 * has to add the adoption state without disturbing the author list it protects.
 */
describe("v12 agreement kind adoption", () => {
	/** A DO paired before v12, holding the four seeded kinds with one hand-tightened. */
	function preV12(): Database.Database {
		const db = doAtVersion(11);
		const insert = db.prepare(
			`INSERT INTO agreement_kinds (id, label, author_permission) VALUES (?, ?, ?)`,
		);
		insert.run("protocol", "Protocol", JSON.stringify(["dom", "switch"]));
		insert.run("ritual", "Ritual", JSON.stringify(["dom", "switch"]));
		// The #129 workaround: a switch+sub couple tightening limits to the sub alone.
		insert.run("limit", "Limit", JSON.stringify(["sub"]));
		insert.run(
			"safeword",
			"Safeword",
			JSON.stringify(["dom", "sub", "switch"]),
		);
		return db;
	}

	function kindRow(
		db: Database.Database,
		id: string,
	): { author_permission: string; adopted: number; upstream_changed: number } {
		return db
			.prepare(
				`SELECT author_permission, adopted, upstream_changed FROM agreement_kinds WHERE id = ?`,
			)
			.get(id) as {
			author_permission: string;
			adopted: number;
			upstream_changed: number;
		};
	}

	it("adds both columns to a DO that already has kinds", () => {
		const db = preV12();
		expect(columns(db, "agreement_kinds")).not.toContain("adopted");
		runMigrations(sqlStorage(db));
		expect(columns(db, "agreement_kinds")).toContain("adopted");
		expect(columns(db, "agreement_kinds")).toContain("upstream_changed");
	});

	it("leaves the couple's author list untouched", () => {
		// The whole point: the migration must not be the thing that undoes a
		// tightening, having just added the machinery that protects it.
		const db = preV12();
		runMigrations(sqlStorage(db));
		expect(JSON.parse(kindRow(db, "limit").author_permission)).toEqual(["sub"]);
	});

	it("defaults every kind to un-adopted and unflagged", () => {
		// No backfill by design (ADR 0010): nobody has edited a kind, so `DEFAULT 0`
		// is exact rather than a guess. `consent_history` holds the evidence if that
		// ever stops being true.
		const db = preV12();
		runMigrations(sqlStorage(db));
		for (const id of ["protocol", "ritual", "limit", "safeword"]) {
			expect(kindRow(db, id).adopted).toBe(0);
			expect(kindRow(db, id).upstream_changed).toBe(0);
		}
	});

	it("brings a fresh DO up with the columns present", () => {
		const db = new Database(":memory:");
		runMigrations(sqlStorage(db));
		expect(columns(db, "agreement_kinds")).toContain("adopted");
		expect(columns(db, "agreement_kinds")).toContain("upstream_changed");
	});
});
