import Database from "better-sqlite3";
import { CoupleDO } from "./couple-do.ts";

/**
 * A `CoupleDO` running in-process, over the SQLite engine the DO embeds (#164).
 *
 * The DO stopped being a thin shell over the pure `shared/` modules some phases
 * ago: `rebuildCounters`, `applyRules`, `reevaluateOnAmendment` and the alarm
 * sweeps are all real logic, all SQL-shaped, and none of it was reachable from a
 * test — five rebuild defects landed in that seam and every one was caught by
 * reading rather than by a failing test (#163's two, #165, #166, and the
 * auto-closed service-minutes credit; see ADR 0012). This is the harness that
 * makes it reachable.
 *
 * The fidelity argument is the same one `migrations.test.ts` made for the
 * migration runner: `better-sqlite3` is the same engine the DO embeds, so the
 * SQL exercised here is the SQL that will run. What is *faked* is only the thin
 * platform wrapper around it — and the wrapper is small enough to enumerate,
 * which is what keeps the fake checkable:
 *
 * - `storage.sql.exec(...).toArray()` — the DO's entire `SqlStorage` surface. It
 *   uses no `.one()`, `.raw()`, `columnNames`, or `databaseSize`.
 * - `storage.setAlarm` / `deleteAlarm` — captured, not scheduled. See below.
 * - `storage.deleteAll` — `purge`'s wipe.
 * - `id.toString()` — the couple id echoed into `Session` and exports.
 * - `blockConcurrencyWhile` — the constructor's migrate-and-seed gate.
 * - `acceptWebSocket` — accepted and dropped; the socket path is not under test.
 *
 * **What this cannot prove.** Alarm *firing* is the platform's job, so the
 * harness captures the requested time and lets a test invoke `alarm()` itself.
 * That covers the handler's logic and the arming arithmetic — "is the alarm set
 * to the right instant, and does draining it do the right thing" — but not that
 * workerd wakes a hibernating DO at that instant. Hibernation and the WebSocket
 * protocol are likewise out of scope. Those stay dev-server territory; if they
 * ever become a defect source, a `@cloudflare/vitest-pool-workers` project
 * scoped to them is the follow-up, and nothing here blocks it.
 */

/** The slice of Workers `SqlStorage` this codebase uses, over better-sqlite3. */
export function sqlStorage(db: Database.Database): SqlStorage {
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

export interface DoHarness {
	/** The DO under test, constructed and migrated. */
	do: CoupleDO;
	/** The backing database, for asserting on rows the public API doesn't expose. */
	db: Database.Database;
	/** The instant the DO last armed its alarm for, or null if it disarmed. */
	alarmAt(): number | null;
	/**
	 * Runs the alarm handler as the platform would on wake. Deliberately explicit:
	 * nothing here fires on its own, so a test that means to exercise a sweep has
	 * to say so.
	 */
	fireAlarm(): Promise<void>;
	/** Every row of `timers`, oldest first — the projection three defects hid in. */
	timerRows(): TimerDebugRow[];
}

/** A `timers` row as stored, before `rowToTimerView` derives anything from it. */
export interface TimerDebugRow {
	id: string;
	kind: string;
	definition: string;
	status: string | null;
	opened_at: number | null;
	closed_at: number | null;
}

/**
 * A fresh DO on an empty database. The constructor runs migrations and seeding
 * through `blockConcurrencyWhile`, which the real runtime does not await either
 * — but the fake awaits it before handing the DO back, so a test never observes
 * a half-seeded schema.
 *
 * Pass an existing database to **wake a second DO over the same storage**. That
 * is what a deploy does: the code changes, and the next wake re-runs migrations
 * and re-seeds against whatever is already there. It is the only way to exercise
 * `ensureSeeded`'s upsert on a couple that has been used (#185).
 */
export async function newCoupleDO(
	existing?: Database.Database,
): Promise<DoHarness> {
	const db = existing ?? new Database(":memory:");
	const sql = sqlStorage(db);
	let alarmAt: number | null = null;
	let gate: Promise<unknown> = Promise.resolve();

	const ctx = {
		id: { toString: () => "test-couple-do-id" },
		storage: {
			sql,
			setAlarm: (at: number) => {
				alarmAt = at;
			},
			deleteAlarm: () => {
				alarmAt = null;
			},
			deleteAll: async () => {
				const tables = db
					.prepare(
						`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
					)
					.all() as { name: string }[];
				for (const { name } of tables) db.exec(`DROP TABLE "${name}"`);
			},
		},
		blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
			gate = fn();
			return gate;
		},
		acceptWebSocket: () => {},
	} as unknown as DurableObjectState;

	const couple = new CoupleDO(ctx, {} as Env);
	await gate;

	return {
		do: couple,
		db,
		alarmAt: () => alarmAt,
		fireAlarm: () => couple.alarm(),
		timerRows: () =>
			db
				.prepare(
					`SELECT id, kind, definition, status, opened_at, closed_at
						FROM timers ORDER BY opened_at ASC, id ASC`,
				)
				.all() as TimerDebugRow[],
	};
}

/** The identity hashes the couple helpers bind, so tests can name a caller. */
export const DOM = "test-identity-dom";
export const SUB = "test-identity-sub";

export interface ActiveCouple extends DoHarness {
	domId: string;
	subId: string;
}

/**
 * A paired couple with roles confirmed — the state every event, rule and timer
 * test needs before it can log anything, since `appendEvent` rejects until the
 * dynamic is active.
 */
export async function activeCouple(): Promise<ActiveCouple> {
	const harness = await newCoupleDO();
	const dom = await harness.do.createCouple(DOM);
	const sub = await harness.do.joinCouple(SUB);
	await harness.do.proposeRoles(DOM, {
		[dom.member_id]: "dom",
		[sub.member_id]: "sub",
	});
	await harness.do.confirmRoles(SUB);
	return { ...harness, domId: dom.member_id, subId: sub.member_id };
}
