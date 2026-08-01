import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ActiveCouple,
	activeCouple,
	DOM,
	newCoupleDO,
	SUB,
} from "./harness.ts";

/**
 * `CoupleDO` driven end to end over the SQLite engine it embeds (#164).
 *
 * These cover the seam no test reached before: `rebuildCounters`, the live
 * apply path it shares with `appendEvent`, re-evaluation on a ruling, the
 * alarm's jobs, and the permission and queue derivations at the DO boundary.
 * Five defects landed in that seam (#163's two, #165, #166, and the auto-closed
 * service-minutes credit), every one of them caught by reading rather than by a
 * failing test — and every one rebuild-only, silent, and in the scoring
 * direction, because a rebuild is the only thing that re-derives a couple's
 * demerits from scratch and nothing surfaces a divergence.
 *
 * The shape most of these take is therefore: build a log, snapshot what the
 * live incremental path produced, rebuild, and assert the two agree. That is
 * ADR 0012's invariant — reset exactly what a rule wrote — stated as a test.
 *
 * See `harness.ts` for what the fake does and does not stand in for.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A fixed Wednesday, so day and week boundaries in these tests are countable. */
const START = Date.parse("2026-01-07T09:00:00.000Z");

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
});
afterEach(() => {
	vi.useRealTimers();
});

/**
 * Advances the clock the DO reads. Deliberately does *not* fire alarms — the
 * platform is what wakes a DO, and the harness does not fake that (see
 * `harness.ts`). Tests that need a sweep either trigger the read-path one, as
 * `listTimers` does, or use {@link advanceFiringAlarms}.
 */
function advance(ms: number): void {
	vi.setSystemTime(Date.now() + ms);
}

/**
 * Advances the clock the way a couple actually experiences it, draining each
 * alarm the DO armed for a moment inside the span, at that moment. Anything
 * off-log and time-driven — the streak rollover, daily and weekly resets, the
 * timer sweeps — happens here and nowhere else.
 */
async function advanceFiringAlarms(
	couple: ActiveCouple,
	ms: number,
): Promise<void> {
	const target = Date.now() + ms;
	// Each firing re-arms at the new minimum, so this walks the schedule forward.
	// Bounded so a mis-armed alarm fails as a test timeout, not a hang.
	for (let guard = 0; guard < 1000; guard += 1) {
		const at = couple.alarmAt();
		if (at === null || at > target) break;
		vi.setSystemTime(Math.max(at, Date.now()));
		await couple.fireAlarm();
	}
	vi.setSystemTime(target);
}

/** Counter values keyed by id, for comparing a live cache against a rebuild. */
async function counters(couple: ActiveCouple): Promise<Record<string, number>> {
	const rows = await couple.do.listCounters(DOM);
	return Object.fromEntries(rows.map((row) => [row.id, row.value]));
}

/** Opens a task countdown via R22, returning the server-minted task id. */
async function assignTask(
	couple: ActiveCouple,
	name: string,
	durationMs: number,
): Promise<string> {
	const event = await couple.do.logEvent(DOM, {
		type: "task_assigned",
		metadata: { task_name: name, duration_ms: durationMs },
		subject: couple.subId,
		visibility: "shared",
	});
	return event.metadata.task_id as string;
}

describe("rebuildCounters — timers", () => {
	/**
	 * A log holding one countdown of each disposition. Two of the three are closed
	 * by something the log does not record — the expiry sweep and a dom command —
	 * which is exactly what makes them hard: replay can re-derive the *open* but
	 * has nothing to re-derive the *close* from.
	 */
	async function threeDispositions(): Promise<ActiveCouple> {
		const couple = await activeCouple();

		// Event-closed: R22 opens on assignment, R4 closes it on completion.
		const completed = await assignTask(couple, "dishes", HOUR);
		advance(60_000);
		await couple.do.logEvent(SUB, {
			type: "task_completed",
			metadata: { task_id: completed },
			subject: couple.subId,
			visibility: "shared",
		});

		// Dom-canceled: a live-control command (ADR 0004), off-log.
		await assignTask(couple, "laundry", HOUR);
		advance(60_000);
		const open = await couple.do.listTimers(DOM);
		const row = open.find(
			(timer) => timer.tag === "laundry" && timer.status === null,
		);
		if (!row) throw new Error("R22 did not open a countdown for laundry");
		await couple.do.cancelTimer(DOM, row.id);

		// Swept-expired: the deadline passes and the sweep closes it, off-log.
		advance(60_000);
		await couple.do.logEvent(DOM, {
			type: "denial_started",
			metadata: { duration_ms: 60_000 },
			subject: couple.subId,
			visibility: "shared",
		});
		advance(2 * 60_000);
		await couple.do.listTimers(DOM); // read-path sweep closes it `expired`

		return couple;
	}

	it("reproduces every countdown disposition exactly", async () => {
		const couple = await threeDispositions();
		const live = couple.timerRows();
		expect(live.map((row) => row.status)).toEqual([
			"completed",
			"canceled",
			"expired",
		]);

		await couple.do.rebuildCounters(DOM);

		// The whole claim in one assertion: same rows, same ids, same dispositions,
		// same close times. A rebuild is not allowed to invent or lose a timer.
		expect(couple.timerRows()).toEqual(live);
	});

	it("stays stable across repeated rebuilds", async () => {
		// #165 accumulated: each rebuild added another running row per countdown
		// event, so the divergence grew every time rather than being a one-off.
		const couple = await threeDispositions();
		await couple.do.rebuildCounters(DOM);
		const once = couple.timerRows();
		await couple.do.rebuildCounters(DOM);
		expect(couple.timerRows()).toEqual(once);
	});

	it("leaves no countdown running that the live path had closed", async () => {
		// The consequence that made #165 more than cosmetic: a phantom-running
		// `denial_period` inverts R26's `timer_active` clause for every event
		// logged after the rebuild.
		const couple = await threeDispositions();
		await couple.do.rebuildCounters(DOM);
		expect(couple.timerRows().filter((row) => row.status === null)).toEqual([]);
	});
});

describe("rebuildCounters — stopwatches", () => {
	/** Opens a session stopwatch via R15, returning the server-minted session id. */
	async function startSession(couple: ActiveCouple): Promise<string> {
		const event = await couple.do.logEvent(DOM, {
			type: "session_started",
			metadata: { activity: "service" },
			subject: couple.subId,
			visibility: "shared",
		});
		return event.metadata.session_id as string;
	}

	it("keeps an over-max auto-close that no event records", async () => {
		// Until #167 stopwatches were deleted wholesale before replay, on the theory
		// that the over-max sweep would re-derive the auto-close. It does not: the
		// sweep runs at `now`, not at the moment being replayed, so the row came back
		// open and stayed open — inverting a `{ session_stopwatch: false }` clause for
		// the rest of the replay, the gap ADR 0011 documented.
		const couple = await activeCouple();
		await startSession(couple);
		advance(24 * HOUR); // service caps well below this
		await couple.do.listTimers(DOM); // read-path sweep auto-closes it

		const live = couple.timerRows();
		expect(live).toHaveLength(1);
		expect(live[0]?.status).toBe("auto_closed");

		await couple.do.rebuildCounters(DOM);
		expect(couple.timerRows()).toEqual(live);
	});

	it("does not credit service minutes the live path withheld", async () => {
		// The sharper half, and the reason this was not merely cosmetic. An
		// auto-closed session is flagged for review, not auto-credited — so R16
		// routes no duration. On replay the re-opened stopwatch *was* open, so R16
		// matched it, closed it `completed`, and routed the full span into
		// `service_minutes_week`. A rebuild silently credited 24 hours of service the
		// couple had never been credited for.
		const couple = await activeCouple();
		const sessionId = await startSession(couple);
		advance(24 * HOUR);
		await couple.do.listTimers(DOM);

		// The genuine end arrives after the sweep: reconciled, still not credited.
		await couple.do.logEvent(DOM, {
			type: "session_ended",
			metadata: { session_id: sessionId, activity: "service" },
			subject: couple.subId,
			visibility: "shared",
		});
		const live = await counters(couple);
		expect(live.service_minutes_week).toBe(0);

		await couple.do.rebuildCounters(DOM);

		expect(await counters(couple)).toEqual(live);
		expect(couple.timerRows()[0]?.status).toBe("auto_closed");
	});

	it("still re-derives a normally completed session", async () => {
		// Preservation must not cost the re-derivation it replaced: a stopwatch R16
		// closed is rule-written, so it is reset and rebuilt like any other.
		const couple = await activeCouple();
		const sessionId = await startSession(couple);
		advance(90 * 60_000);
		await couple.do.logEvent(DOM, {
			type: "session_ended",
			metadata: { session_id: sessionId, activity: "service" },
			subject: couple.subId,
			visibility: "shared",
		});

		const live = await counters(couple);
		expect(live.service_minutes_week).toBe(90);

		await couple.do.rebuildCounters(DOM);

		expect(await counters(couple)).toEqual(live);
		expect(couple.timerRows()[0]?.status).toBe("completed");
	});

	it("does not double-credit a completed session across repeated rebuilds", async () => {
		const couple = await activeCouple();
		const sessionId = await startSession(couple);
		advance(90 * 60_000);
		await couple.do.logEvent(DOM, {
			type: "session_ended",
			metadata: { session_id: sessionId, activity: "service" },
			subject: couple.subId,
			visibility: "shared",
		});

		await couple.do.rebuildCounters(DOM);
		const once = await counters(couple);
		await couple.do.rebuildCounters(DOM);
		expect(await counters(couple)).toEqual(once);
		expect(couple.timerRows()).toHaveLength(1);
	});
});

describe("rebuildCounters — ambient state (ADR 0011)", () => {
	/**
	 * R26's shape: a rule whose condition reads whether a `denial_period` was
	 * running, which is ambient — nothing in the orgasm event says it. Both #163
	 * defects were this rule scoring differently on rebuild than it had live, so
	 * the case that matters is an unpermitted orgasm on each side of the denial.
	 *
	 * Demerits are the ledger to watch: R12 adds 2 for any unpermitted orgasm, and
	 * R26 adds 2 more only during a denial. So the one inside is worth 4 and the
	 * two outside 2 each — 8 in total, and any divergence shows up as 10 or 6.
	 */
	async function orgasmsAroundADenial(): Promise<ActiveCouple> {
		const couple = await activeCouple();

		const unpermitted = async () => {
			await couple.do.logEvent(SUB, {
				type: "orgasm",
				metadata: { permitted: false, outcome: "full" },
				subject: couple.subId,
				visibility: "shared",
			});
		};

		// Before: no denial has ever run, so R26 must not fire.
		await unpermitted();

		advance(HOUR);
		await couple.do.logEvent(DOM, {
			type: "denial_started",
			metadata: { duration_ms: 2 * HOUR },
			subject: couple.subId,
			visibility: "shared",
		});

		// During: R26 fires, and R14 closes the denial `failed` in the same breath.
		advance(HOUR);
		await unpermitted();

		// After: the denial ended when R14 closed it, so R26 must not fire again.
		advance(HOUR);
		await unpermitted();

		return couple;
	}

	it("scores an unpermitted orgasm the same before, during and after a denial", async () => {
		const couple = await orgasmsAroundADenial();
		const live = await counters(couple);
		expect(live.demerits).toBe(8);
		expect(live.orgasms_unpermitted).toBe(3);

		await couple.do.rebuildCounters(DOM);

		expect(await counters(couple)).toEqual(live);
	});

	it("resolves the denial from its span, not its current status", async () => {
		// The first #163 defect: `rebuildCounters` resets rule-closed countdowns to
		// running before replaying, so a predicate reading `status IS NULL` saw the
		// denial as active from the very first replayed event — and escalated the
		// orgasm that predated it. Reading the durable span answers the same for a
		// past moment as it did live, which is what makes this stable.
		const couple = await orgasmsAroundADenial();
		await couple.do.rebuildCounters(DOM);
		const once = await counters(couple);
		await couple.do.rebuildCounters(DOM);
		expect(await counters(couple)).toEqual(once);
	});

	it("never stamps a close earlier than the open it closed", async () => {
		// The defect this pins is the one #165 was hiding. `rebuildCounters` resets
		// rule-closed countdowns to running *before* replaying, so mid-replay every
		// one of them reads as open from the beginning of the log. R14's close
		// matched on status alone, so the earliest unpermitted orgasm closed a denial
		// that had not started yet — leaving `closed_at` before `opened_at`, a span
		// that then read as shut for the rest of the replay.
		//
		// It stayed invisible because the duplicate row #165 inserted was open and
		// unbounded, so R26 still fired off the duplicate and the counter landed on
		// the right total for the wrong reason. Fixing #165 alone turned it into a
		// visible under-count.
		const couple = await orgasmsAroundADenial();
		await couple.do.rebuildCounters(DOM);
		for (const row of couple.timerRows()) {
			if (row.closed_at === null || row.opened_at === null) continue;
			expect(row.closed_at).toBeGreaterThanOrEqual(row.opened_at);
		}
	});

	it("does not escalate against a denial the sweep expired", async () => {
		// The second #163 defect, one step down: `expired` is off-log, so replay
		// never re-closes it. A blanket reset stranded it open and it read as
		// running for the rest of the replay.
		const couple = await activeCouple();
		await couple.do.logEvent(DOM, {
			type: "denial_started",
			metadata: { duration_ms: HOUR },
			subject: couple.subId,
			visibility: "shared",
		});
		advance(2 * HOUR);
		await couple.do.listTimers(DOM); // sweep closes it `expired`
		await couple.do.logEvent(SUB, {
			type: "orgasm",
			metadata: { permitted: false, outcome: "full" },
			subject: couple.subId,
			visibility: "shared",
		});

		const live = await counters(couple);
		// R12 only — the denial had already expired, so R26 must stay silent.
		expect(live.demerits).toBe(2);

		await couple.do.rebuildCounters(DOM);
		expect(await counters(couple)).toEqual(live);
	});
});

describe("applyRules writes a trace row for every effect", () => {
	/**
	 * "Every change has a recorded cause" (handoff §4.6) is the claim the trace
	 * makes, and a rebuild is supposed to reproduce it — `rebuildCounters` clears
	 * the trace and rebuilds it from the same apply-path. Asserting only on counter
	 * values would let the ledger drift from the numbers it explains, which is the
	 * half of the rebuild claim that the value comparisons cannot see.
	 */
	async function unpermittedOrgasm(): Promise<{
		couple: ActiveCouple;
		eventId: string;
	}> {
		const couple = await activeCouple();
		const event = await couple.do.logEvent(SUB, {
			type: "orgasm",
			metadata: { permitted: false, outcome: "full" },
			subject: couple.subId,
			visibility: "shared",
		});
		return { couple, eventId: event.id };
	}

	it("records the rule and projection behind each fired effect", async () => {
		const { couple, eventId } = await unpermittedOrgasm();
		const rows = await couple.do.getEventTrace(DOM, eventId);

		// R10 counts it, R12 fans out across two counters and two anchors, R14 tries
		// the denial close. Each is a separate, individually attributed row.
		const byRule = rows.map((row) => [
			row.cause.by === "rule" ? row.cause.rule : row.cause.by,
			row.projection,
		]);
		expect(byRule).toContainEqual(["R10", "counter:orgasms_lifetime"]);
		expect(byRule).toContainEqual(["R12", "counter:orgasms_unpermitted"]);
		expect(byRule).toContainEqual(["R12", "counter:demerits"]);
		expect(byRule).toContainEqual(["R12", "anchor:since_last_orgasm"]);
		expect(byRule).toContainEqual(["R12", "anchor:since_last_infraction"]);
		// Every row names the event that caused it — the drill-in the log view uses.
		for (const row of rows) {
			expect(row.cause.by).toBe("rule");
			if (row.cause.by !== "rule") continue;
			expect(row.cause.event).toBe(eventId);
		}
	});

	it("records a counter's from and to, not just that it moved", async () => {
		const { couple } = await unpermittedOrgasm();
		const trace = await couple.do.getCounterTrace(DOM, "demerits");
		expect(trace.value).toBe(2);
		const detail = trace.rows[0]?.detail;
		if (detail?.kind !== "counter")
			throw new Error("expected a counter detail");
		expect(detail.from).toBe(0);
		expect(detail.to).toBe(2);
		expect(detail.by).toBe(2);
	});

	it("traces an unmatched close rather than silently doing nothing", async () => {
		// R14 fires on every unpermitted orgasm, denial or no denial. With none
		// running the close matches nothing — and says so, rather than leaving the
		// couple to infer from an absence.
		const { couple, eventId } = await unpermittedOrgasm();
		const rows = await couple.do.getEventTrace(DOM, eventId);
		const close = rows.find(
			(row) =>
				row.detail.kind === "timer_close" &&
				row.projection?.includes("denial_period"),
		);
		if (close?.detail.kind !== "timer_close") {
			throw new Error("R14 wrote no close trace");
		}
		expect(close.detail.matched).toBe(false);
		expect(close.detail.note).toBe("no matching open timer");
	});

	it("rebuilds the trace to match what the live path wrote", async () => {
		const { couple, eventId } = await unpermittedOrgasm();
		const live = await couple.do.getEventTrace(DOM, eventId);
		expect(live.length).toBeGreaterThan(0);

		await couple.do.rebuildCounters(DOM);

		const rebuilt = await couple.do.getEventTrace(DOM, eventId);
		// Row ids are reassigned by the rebuild — the ledger is rewritten, not
		// amended — so compare everything that carries meaning.
		const meaningful = (rows: typeof live) =>
			rows.map(({ at, cause, projection, detail }) => ({
				at,
				cause,
				projection,
				detail,
			}));
		expect(meaningful(rebuilt)).toEqual(meaningful(live));
	});
});

describe("a close matches only a timer that had already opened", () => {
	it("treats a close backdated before the open as an orphan", async () => {
		// `occurred_at` is caller-settable, so this is reachable live and not only
		// under replay: a task completed "yesterday" cannot have completed a
		// countdown assigned today. Before the span bound, R4 closed it anyway and
		// `durationOf` clamped the negative span to 0 — a closed countdown claiming
		// it took no time. An orphan with a trace note is the truthful answer.
		const couple = await activeCouple();
		const taskId = await assignTask(couple, "dishes", HOUR);
		const openedAt = Date.now();

		advance(60_000);
		await couple.do.logEvent(SUB, {
			type: "task_completed",
			metadata: { task_id: taskId },
			subject: couple.subId,
			occurred_at: openedAt - HOUR,
			visibility: "shared",
		});

		const rows = couple.timerRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBeNull();
	});

	it("still closes a normally-ordered completion", async () => {
		const couple = await activeCouple();
		const taskId = await assignTask(couple, "dishes", HOUR);

		advance(60_000);
		await couple.do.logEvent(SUB, {
			type: "task_completed",
			metadata: { task_id: taskId },
			subject: couple.subId,
			visibility: "shared",
		});

		expect(couple.timerRows()[0]?.status).toBe("completed");
	});
});

describe("the single alarm", () => {
	/**
	 * A DO gets one alarm, so waking has to drain *everything* due — not just the
	 * job that tripped it — and then re-arm at the new minimum across every source
	 * (handoff §3.2). These drive `alarm()` directly rather than leaning on the
	 * read-path sweeps, because the read path is the safety net and the alarm is
	 * the thing that is supposed to make consequences land on time.
	 */

	it("arms for the nearest consequence across schedules and timers", async () => {
		const couple = await activeCouple();
		// The rollover schedule alone arms it: the coming UTC midnight.
		const rolloverAt = couple.alarmAt();
		if (rolloverAt === null) throw new Error("no alarm armed for the rollover");

		// A countdown due sooner than that must win — MIN over all sources.
		await couple.do.logEvent(DOM, {
			type: "denial_started",
			metadata: { duration_ms: HOUR },
			subject: couple.subId,
			visibility: "shared",
		});
		expect(couple.alarmAt()).toBe(START + HOUR);
		expect(couple.alarmAt()).toBeLessThan(rolloverAt);
	});

	it("expires a countdown on the alarm, not merely on the next read", async () => {
		const couple = await activeCouple();
		await couple.do.logEvent(DOM, {
			type: "denial_started",
			metadata: { duration_ms: HOUR },
			subject: couple.subId,
			visibility: "shared",
		});

		await advanceFiringAlarms(couple, 2 * HOUR);

		// Closed by the sweep the alarm ran — nothing here has called listTimers.
		const rows = couple.timerRows();
		expect(rows[0]?.status).toBe("expired");
	});

	it("auto-closes an over-max stopwatch on the alarm", async () => {
		const couple = await activeCouple();
		await couple.do.logEvent(DOM, {
			type: "session_started",
			metadata: { activity: "service" },
			subject: couple.subId,
			visibility: "shared",
		});

		await advanceFiringAlarms(couple, 24 * HOUR);

		expect(couple.timerRows()[0]?.status).toBe("auto_closed");
	});

	it("re-arms at the new minimum once the nearest consequence retires", async () => {
		const couple = await activeCouple();
		await couple.do.logEvent(DOM, {
			type: "denial_started",
			metadata: { duration_ms: HOUR },
			subject: couple.subId,
			visibility: "shared",
		});
		expect(couple.alarmAt()).toBe(START + HOUR);

		await advanceFiringAlarms(couple, 2 * HOUR);

		// The denial is done, so the alarm falls back to the rollover schedule
		// rather than staying armed for a consequence that has already fired.
		const at = couple.alarmAt();
		if (at === null) throw new Error("alarm disarmed with a rollover pending");
		expect(at).toBeGreaterThan(Date.now());
	});

	it("folds a streak before clearing the counter it reads", async () => {
		// Streaks first, then resets: the fold reads its target's end-of-period
		// value, so a reset that ran first would score every day a miss. The
		// ordering is invisible in the counter values unless a period is actually
		// crossed with the target met.
		const couple = await activeCouple();
		await couple.do.logEvent(SUB, {
			type: "ritual_completed",
			metadata: {},
			subject: couple.subId,
			visibility: "shared",
		});
		expect((await counters(couple)).rituals_completed_today).toBe(1);

		await advanceFiringAlarms(couple, DAY);

		const after = await counters(couple);
		expect(after.rituals_completed_today).toBe(0); // reset ran
		expect(after.ritual_streak_days).toBe(1); // fold saw the pre-reset value
	});

	it("breaks a streak on a period the target went unmet", async () => {
		const couple = await activeCouple();
		await couple.do.logEvent(SUB, {
			type: "ritual_completed",
			metadata: {},
			subject: couple.subId,
			visibility: "shared",
		});
		await advanceFiringAlarms(couple, DAY);
		expect((await counters(couple)).ritual_streak_days).toBe(1);

		// A day with no ritual at all.
		await advanceFiringAlarms(couple, DAY);
		expect((await counters(couple)).ritual_streak_days).toBe(0);
	});

	it("re-derives the streak on a rebuild, matching what the alarm folded", async () => {
		// Streaks were carried across a rebuild until ADR 0013 — the one projection
		// replay could reconstruct but was not allowed to, because the target a fold
		// compares against had no effective-dated history. Now they replay like
		// everything else.
		const couple = await activeCouple();
		await couple.do.logEvent(SUB, {
			type: "ritual_completed",
			metadata: {},
			subject: couple.subId,
			visibility: "shared",
		});
		await advanceFiringAlarms(couple, DAY);
		const live = await counters(couple);
		expect(live.ritual_streak_days).toBe(1);

		await couple.do.rebuildCounters(DOM);

		expect(await counters(couple)).toEqual(live);
	});

	it("disarms rather than firing consequences while paused", async () => {
		// Safeword: no consequence may fire, on the alarm or on a read.
		const couple = await activeCouple();
		await couple.do.logEvent(DOM, {
			type: "denial_started",
			metadata: { duration_ms: HOUR },
			subject: couple.subId,
			visibility: "shared",
		});
		await couple.do.pause(DOM);
		expect(couple.alarmAt()).toBeNull();

		advance(4 * HOUR);
		await couple.fireAlarm();

		// The deadline passed during the pause, and nothing expired.
		expect(couple.timerRows()[0]?.status).toBeNull();
	});
});

describe("adjudication resolves rules at the target's log-time (ADR 0002)", () => {
	/**
	 * A custom rule that only fires once the dom rules on `permitted`, so the
	 * effect it carries can be changed in between the event and the ruling. Sub is
	 * the subject, so `permitted` sits in the type's `awaiting` set and the rule
	 * near-misses until adjudicated.
	 */
	function scoringRule(by: number) {
		return {
			id: "custom-unpermitted-tally",
			name: "Unpermitted tally",
			condition: {
				type: "orgasm",
				subject_role: "sub",
				metadata: { permitted: false },
			},
			effects: [{ verb: "increment_counter", counter: "edges_sub", by }],
		};
	}

	/**
	 * Rule says +5. An orgasm is logged, awaiting adjudication. The dom then edits
	 * the rule to +50 — forward-only, a new effective-dated version (ADR 0002) —
	 * and only afterwards rules on the old event.
	 */
	async function ruledOnAfterTheRuleChanged(): Promise<ActiveCouple> {
		const couple = await activeCouple();
		await couple.do.createRule(DOM, scoringRule(5));

		advance(HOUR);
		const orgasm = await couple.do.logEvent(SUB, {
			type: "orgasm",
			metadata: { outcome: "full" },
			subject: couple.subId,
			visibility: "shared",
		});
		expect((await counters(couple)).edges_sub).toBe(0); // awaiting, not fired

		advance(HOUR);
		const { id, ...definition } = scoringRule(50);
		await couple.do.updateRule(DOM, id, definition);

		advance(HOUR);
		await couple.do.amend(DOM, {
			kind: "adjudication",
			target_event_id: orgasm.id,
			patch: { permitted: false },
		});
		return couple;
	}

	it("fires the version in force when the event was logged, not today's", async () => {
		const couple = await ruledOnAfterTheRuleChanged();
		// +5, the rule as it stood when the orgasm was logged. Scoring it +50 would
		// be the ruling smuggling in a rule the couple never lived under — exactly
		// what forward-only effective dating exists to prevent.
		expect((await counters(couple)).edges_sub).toBe(5);
	});

	it("resolves the same version again on rebuild", async () => {
		// Rebuild replays each ruling at its own timestamp, which is the moment most
		// likely to reach for "the current rules" — the version resolution has to key
		// off the *target's* log-time both times or history re-scores itself.
		const couple = await ruledOnAfterTheRuleChanged();
		const live = await counters(couple);
		await couple.do.rebuildCounters(DOM);
		expect(await counters(couple)).toEqual(live);
		expect((await counters(couple)).edges_sub).toBe(5);
	});
});

describe("a ruling never performs retroactive timer surgery", () => {
	/**
	 * A denial running, and an orgasm logged while `permitted` is still awaiting the
	 * dom's ruling. R14 — "unpermitted orgasm breaks the denial" — cannot fire until
	 * that ruling lands, so the ruling is what decides whether a timer gets closed.
	 * Whether the denial is still running *at the moment of the ruling* is the whole
	 * question (handoff §4.2).
	 */
	async function orgasmAwaitingRuling(denialMs: number): Promise<{
		couple: ActiveCouple;
		eventId: string;
	}> {
		const couple = await activeCouple();
		await couple.do.logEvent(DOM, {
			type: "denial_started",
			metadata: { duration_ms: denialMs },
			subject: couple.subId,
			visibility: "shared",
		});
		advance(60_000);
		const event = await couple.do.logEvent(SUB, {
			type: "orgasm",
			metadata: { outcome: "full" },
			subject: couple.subId,
			visibility: "shared",
		});
		return { couple, eventId: event.id };
	}

	async function rule(couple: ActiveCouple, eventId: string): Promise<void> {
		await couple.do.amend(DOM, {
			kind: "adjudication",
			target_event_id: eventId,
			patch: { permitted: false },
		});
	}

	it("closes the denial when the ruling lands while it still runs", async () => {
		const { couple, eventId } = await orgasmAwaitingRuling(4 * HOUR);
		advance(HOUR);
		await rule(couple, eventId);

		const denial = couple.timerRows()[0];
		expect(denial?.status).toBe("failed");
	});

	it("skips, with a stated reason, when the denial already ended", async () => {
		// The denial expires before the dom gets round to ruling. Closing it now
		// would be rewriting a timer that has already run its course — so the effect
		// is declined and the decline is recorded, rather than silently dropped.
		const { couple, eventId } = await orgasmAwaitingRuling(HOUR);
		advance(4 * HOUR);
		await couple.do.listTimers(DOM); // sweep expires it

		await rule(couple, eventId);

		const denial = couple.timerRows()[0];
		expect(denial?.status).toBe("expired"); // untouched by the ruling

		const rows = await couple.do.getEventTrace(DOM, eventId);
		const skipped = rows.find((row) => row.detail.kind === "timer_skipped");
		if (skipped?.detail.kind !== "timer_skipped") {
			throw new Error("no skip trace for the declined close");
		}
		expect(skipped.detail.op).toBe("close");
		expect(skipped.detail.reason).toContain("R14");
		expect(skipped.cause.by).toBe("amendment");
	});

	it("still scores the counter effects the ruling unlocked", async () => {
		// Two clocks, and they are meant to differ. The *timer* effect is declined
		// because there is nothing left to close at the moment of the ruling — that
		// is the no-retroactive-surgery rule. The *condition* is a different
		// question: R26 asks whether a denial was running when the orgasm occurred,
		// and it was, so the escalation lands (ADR 0011's "an amendment asks what was
		// running then"). Declining the effect must not quietly decline the score.
		const { couple, eventId } = await orgasmAwaitingRuling(HOUR);
		advance(4 * HOUR);
		await couple.do.listTimers(DOM);
		await rule(couple, eventId);

		// R12 (+2) for the unpermitted orgasm, R26 (+2) for it landing inside a
		// denial that had since expired.
		expect((await counters(couple)).demerits).toBe(4);
	});

	it("does not escalate a ruling on an orgasm outside the denial", async () => {
		// The companion case, so the previous test is pinned to the event's clock
		// rather than to "R26 always fires on a ruling": same shape, but the orgasm
		// occurs after the denial has run out.
		const couple = await activeCouple();
		await couple.do.logEvent(DOM, {
			type: "denial_started",
			metadata: { duration_ms: HOUR },
			subject: couple.subId,
			visibility: "shared",
		});
		advance(4 * HOUR);
		await couple.do.listTimers(DOM); // expired before the orgasm
		const event = await couple.do.logEvent(SUB, {
			type: "orgasm",
			metadata: { outcome: "full" },
			subject: couple.subId,
			visibility: "shared",
		});

		advance(HOUR);
		await rule(couple, event.id);

		// R12 only. The denial was already over when this happened.
		expect((await counters(couple)).demerits).toBe(2);
	});

	it("reproduces the skip on rebuild", async () => {
		const { couple, eventId } = await orgasmAwaitingRuling(HOUR);
		advance(4 * HOUR);
		await couple.do.listTimers(DOM);
		await rule(couple, eventId);

		const liveCounters = await counters(couple);
		const liveTimers = couple.timerRows();

		await couple.do.rebuildCounters(DOM);

		expect(await counters(couple)).toEqual(liveCounters);
		expect(couple.timerRows()).toEqual(liveTimers);
		const rebuilt = await couple.do.getEventTrace(DOM, eventId);
		expect(rebuilt.some((row) => row.detail.kind === "timer_skipped")).toBe(
			true,
		);
	});
});

describe("rebuildCounters — streaks (ADR 0013)", () => {
	async function ritual(couple: ActiveCouple): Promise<void> {
		await couple.do.logEvent(SUB, {
			type: "ritual_completed",
			metadata: {},
			subject: couple.subId,
			visibility: "shared",
		});
	}

	it("walks every boundary in a gap, not just the first", async () => {
		// The defect this pins. Rollover replay used to collapse multiple boundaries
		// of one period into a single pass, on the reasoning that a gap spans no
		// events so nothing accrues between them. True for a reset, which is
		// idempotent; false for a streak fold, which is not. A met day then three
		// idle ones folds +1, 0, 0, 0 and ends at zero — a single collapsed fold
		// would score the met day and stop, leaving a streak alive across days the
		// couple did nothing.
		const couple = await activeCouple();
		await ritual(couple);
		await advanceFiringAlarms(couple, DAY);
		expect((await counters(couple)).ritual_streak_days).toBe(1);

		await advanceFiringAlarms(couple, 3 * DAY);
		const live = await counters(couple);
		expect(live.ritual_streak_days).toBe(0);

		await couple.do.rebuildCounters(DOM);

		expect(await counters(couple)).toEqual(live);
	});

	it("reproduces a run of met days", async () => {
		const couple = await activeCouple();
		for (let day = 0; day < 3; day += 1) {
			await ritual(couple);
			await advanceFiringAlarms(couple, DAY);
		}
		const live = await counters(couple);
		expect(live.ritual_streak_days).toBe(3);

		await couple.do.rebuildCounters(DOM);
		expect(await counters(couple)).toEqual(live);
	});

	it("is stable across repeated rebuilds", async () => {
		const couple = await activeCouple();
		await ritual(couple);
		await advanceFiringAlarms(couple, DAY);
		await ritual(couple);
		await advanceFiringAlarms(couple, 2 * DAY);

		await couple.do.rebuildCounters(DOM);
		const once = await counters(couple);
		await couple.do.rebuildCounters(DOM);
		expect(await counters(couple)).toEqual(once);
	});

	it("scores a past period against the target in force then, not today's", async () => {
		// The whole reason counter definitions had to be versioned before streaks
		// could be re-derived. One ritual a day meets a target of 1; raising the
		// target to 5 afterwards must not retroactively turn those met days into
		// missed ones on the next rebuild.
		const couple = await activeCouple();
		await ritual(couple);
		await advanceFiringAlarms(couple, DAY);
		await ritual(couple);
		await advanceFiringAlarms(couple, DAY);
		const live = await counters(couple);
		expect(live.ritual_streak_days).toBe(2);

		await couple.do.updateCounter(DOM, "rituals_completed_today", {
			name: "Rituals completed today",
			valence: "positive",
			daily_target: 5,
			reset: "daily",
			modify_permission: ["dom", "sub", "switch"],
		});

		await couple.do.rebuildCounters(DOM);

		// Both past days were met under the target of 1 that was actually in force.
		expect((await counters(couple)).ritual_streak_days).toBe(2);
	});

	it("applies a raised target only to the periods after the edit", async () => {
		// The forward half of the same claim: once the new target takes force, a day
		// that would have met the old one breaks the streak.
		const couple = await activeCouple();
		await ritual(couple);
		await advanceFiringAlarms(couple, DAY);
		expect((await counters(couple)).ritual_streak_days).toBe(1);

		await couple.do.updateCounter(DOM, "rituals_completed_today", {
			name: "Rituals completed today",
			valence: "positive",
			daily_target: 5,
			reset: "daily",
			modify_permission: ["dom", "sub", "switch"],
		});

		await ritual(couple); // one ritual, against a target of five
		await advanceFiringAlarms(couple, DAY);
		const live = await counters(couple);
		expect(live.ritual_streak_days).toBe(0);

		await couple.do.rebuildCounters(DOM);
		expect(await counters(couple)).toEqual(live);
	});

	it("folds nothing for a counter that did not exist yet", async () => {
		// A version history that begins after a boundary means the counter was not
		// there to be folded, which is different from being there and unmet.
		const couple = await activeCouple();
		await advanceFiringAlarms(couple, 2 * DAY);

		await couple.do.createCounter(DOM, {
			name: "Late arrival",
			valence: "positive",
			daily_target: 1,
			reset: "daily",
			modify_permission: ["dom", "sub", "switch"],
		});
		const streak = await couple.do.createCounter(DOM, {
			name: "Late arrival streak",
			valence: "positive",
			reset: "never",
			streak: { counter: "late_arrival", period: "daily" },
			modify_permission: ["dom", "sub", "switch"],
		});

		await advanceFiringAlarms(couple, DAY);
		const live = await counters(couple);

		await couple.do.rebuildCounters(DOM);

		expect(await counters(couple)).toEqual(live);
		expect((await counters(couple))[streak.id]).toBe(0);
	});

	it("stamps the boundary, not the moment the alarm woke", async () => {
		// The platform never wakes a DO exactly on the boundary, so `Date.now()` at
		// wake is always a little past it. Stamping that moment made the rollover's
		// `updated_at` and trace rows unreproducible — a replay walks each boundary
		// *at* the boundary, so every rebuild silently shifted the ledger by however
		// late the alarm ran. The fold is a fact about the period, not about when
		// the scheduler got round to it.
		//
		// `advanceFiringAlarms` cannot catch this: it sets the clock exactly to the
		// armed time, which is the one case where the two agree. This drives the
		// alarm by hand, late, on purpose.
		const couple = await activeCouple();
		await ritual(couple);
		const boundary = couple.alarmAt();
		if (boundary === null) throw new Error("no rollover armed");

		vi.setSystemTime(boundary + 90_000); // woke a minute and a half late
		await couple.fireAlarm();

		const stamps = () =>
			couple.db
				.prepare(
					`SELECT id, updated_at FROM counters
						WHERE id IN ('ritual_streak_days', 'rituals_completed_today')
						ORDER BY id`,
				)
				.all();
		const live = stamps();
		expect(live).toEqual([
			{ id: "ritual_streak_days", updated_at: boundary },
			{ id: "rituals_completed_today", updated_at: boundary },
		]);

		await couple.do.rebuildCounters(DOM);

		expect(stamps()).toEqual(live);
	});

	it("rebuilds the rollover trace the alarm wrote", async () => {
		// Replaying rollovers through `runRollover` rather than a bare UPDATE means
		// the streak and scheduled-reset trace rows come back too — before ADR 0013
		// the rebuild zeroed period counters without recording why.
		const couple = await activeCouple();
		await ritual(couple);
		await advanceFiringAlarms(couple, DAY);
		const live = await couple.do.getCounterTrace(DOM, "ritual_streak_days");
		expect(live.rows.length).toBeGreaterThan(0);

		await couple.do.rebuildCounters(DOM);

		const rebuilt = await couple.do.getCounterTrace(DOM, "ritual_streak_days");
		const meaningful = (rows: typeof live.rows) =>
			rows.map(({ at, cause, projection, detail }) => ({
				at,
				cause,
				projection,
				detail,
			}));
		expect(meaningful(rebuilt.rows)).toEqual(meaningful(live.rows));
	});
});

describe("permissions at the DO boundary", () => {
	/**
	 * The DO is the only thing enforcing these. The router hands it an identity
	 * hash and nothing else, so a client that skips the UI reaches exactly these
	 * checks — which makes them the actual boundary, not the screens.
	 */

	it("refuses a stranger every read and every write", async () => {
		const couple = await activeCouple();
		await expect(couple.do.getState("not-a-member")).rejects.toThrow(
			"not a member",
		);
		await expect(couple.do.listCounters("not-a-member")).rejects.toThrow(
			"not a member",
		);
		await expect(
			couple.do.logEvent("not-a-member", {
				type: "check_in",
				metadata: { mood: 3 },
				subject: couple.subId,
				visibility: "shared",
			}),
		).rejects.toThrow("not a member");
	});

	it("gates an event type on the logger's role", async () => {
		const couple = await activeCouple();
		// `task_assigned` is dom/switch only — assigning yourself a task is the
		// dynamic running backwards.
		await expect(
			couple.do.logEvent(SUB, {
				type: "task_assigned",
				metadata: { task_name: "dishes", duration_ms: HOUR },
				subject: couple.subId,
				visibility: "shared",
			}),
		).rejects.toThrow("your role may not log this event type");
	});

	it("keeps countdown live-control to the dom", async () => {
		const couple = await activeCouple();
		await couple.do.logEvent(DOM, {
			type: "denial_started",
			metadata: { duration_ms: HOUR },
			subject: couple.subId,
			visibility: "shared",
		});
		const timer = (await couple.do.listTimers(SUB))[0];
		if (!timer) throw new Error("no countdown opened");

		for (const call of [
			() => couple.do.cancelTimer(SUB, timer.id),
			() => couple.do.pauseTimer(SUB, timer.id),
			() => couple.do.extendTimer(SUB, timer.id, { by_ms: HOUR }),
		]) {
			await expect(call()).rejects.toThrow(
				"only the dom may manage countdowns",
			);
		}
	});

	it("keeps rule authoring to a dom or switch", async () => {
		const couple = await activeCouple();
		const definition = {
			id: "custom-sub-authored",
			name: "Sub authored",
			condition: { type: "check_in", metadata: {} },
			effects: [{ verb: "increment_counter", counter: "check_ins_week" }],
		};
		await expect(couple.do.createRule(SUB, definition)).rejects.toThrow(
			"only a dom or switch may change rules",
		);
	});

	it("refuses every write once the couple is paused", async () => {
		// Safeword halts the dynamic, not just its consequences.
		const couple = await activeCouple();
		await couple.do.pause(DOM);
		await expect(
			couple.do.logEvent(DOM, {
				type: "check_in",
				metadata: { mood: 3 },
				subject: couple.subId,
				visibility: "shared",
			}),
		).rejects.toThrow();
	});

	it("refuses logging before roles are confirmed", async () => {
		const couple = await newCoupleDO();
		await couple.do.createCouple(DOM);
		const sub = await couple.do.joinCouple(SUB);
		await expect(
			couple.do.logEvent(DOM, {
				type: "check_in",
				metadata: { mood: 3 },
				subject: sub.member_id,
				visibility: "shared",
			}),
		).rejects.toThrow("roles are not confirmed yet");
	});

	it("closes the couple to a third member, permanently", async () => {
		const couple = await activeCouple();
		await expect(couple.do.joinCouple("a-third-identity")).rejects.toThrow();
	});
});

describe("pending and the adjudication queue", () => {
	/**
	 * An event is *pending* while a metadata key its type marks `awaiting` has no
	 * value and the role that must supply it has not ruled. The queue is that same
	 * derivation counted for one member — the number the home screen badges.
	 */

	async function orgasmAwaitingPermission(): Promise<{
		couple: ActiveCouple;
		eventId: string;
	}> {
		const couple = await activeCouple();
		const event = await couple.do.logEvent(SUB, {
			type: "orgasm",
			metadata: { outcome: "full" },
			subject: couple.subId,
			visibility: "shared",
		});
		return { couple, eventId: event.id };
	}

	it("marks an event pending while its awaiting key is unset", async () => {
		const { couple, eventId } = await orgasmAwaitingPermission();
		const events = await couple.do.listEvents(DOM, null);
		expect(events.find((e) => e.id === eventId)?.pending).toBe(true);
	});

	it("queues the ruling for the dom, not for the sub who logged it", async () => {
		// `permitted` is adjudicated_by dom, so it is the dom's queue that carries
		// it — the sub cannot resolve their own pending orgasm.
		const { couple } = await orgasmAwaitingPermission();
		expect(await couple.do.queueCount(DOM)).toEqual({ awaiting: 1 });
		expect(await couple.do.queueCount(SUB)).toEqual({ awaiting: 0 });
	});

	it("clears both the pending flag and the queue once ruled", async () => {
		const { couple, eventId } = await orgasmAwaitingPermission();
		await couple.do.amend(DOM, {
			kind: "adjudication",
			target_event_id: eventId,
			patch: { permitted: false },
		});

		const events = await couple.do.listEvents(DOM, null);
		expect(events.find((e) => e.id === eventId)?.pending).toBe(false);
		expect(await couple.do.queueCount(DOM)).toEqual({ awaiting: 0 });
	});

	it("does not queue an event that carried its awaiting key from the start", async () => {
		const couple = await activeCouple();
		await couple.do.logEvent(SUB, {
			type: "orgasm",
			metadata: { outcome: "full", permitted: true },
			subject: couple.subId,
			visibility: "shared",
		});
		expect(await couple.do.queueCount(DOM)).toEqual({ awaiting: 0 });
	});
});

describe("rebuildCounters — period resets", () => {
	/**
	 * Daily and weekly counters are cleared by the off-log `scheduled_reset` alarm,
	 * so a naive replay re-adds every increment ever logged and inflates them to
	 * lifetime totals. Rebuild repairs this by folding the boundaries in between
	 * replay steps — this checks the boundaries land between the *same* folds they
	 * did live, which is the part a count-only assertion would miss.
	 */
	async function checkInsAcrossAWeekBoundary(): Promise<ActiveCouple> {
		const couple = await activeCouple();

		const checkIn = async () => {
			await couple.do.logEvent(SUB, {
				type: "check_in",
				metadata: { mood: 4 },
				subject: couple.subId,
				visibility: "shared",
			});
		};

		// Two in the first week, then a boundary the rollover alarm crosses, then
		// one in the next.
		await checkIn();
		await advanceFiringAlarms(couple, DAY);
		await checkIn();
		await advanceFiringAlarms(couple, 7 * DAY);
		await checkIn();
		return couple;
	}

	it("carries only the current period's folds, live and rebuilt alike", async () => {
		const couple = await checkInsAcrossAWeekBoundary();
		const live = await counters(couple);
		// Only the third check-in is in the current week; the weekly rollover
		// cleared the first two.
		expect(live.check_ins_week).toBe(1);

		await couple.do.rebuildCounters(DOM);

		expect(await counters(couple)).toEqual(live);
	});

	it("does not inflate a period counter to its lifetime total", async () => {
		const couple = await checkInsAcrossAWeekBoundary();
		await couple.do.rebuildCounters(DOM);
		expect((await counters(couple)).check_ins_week).not.toBe(3);
	});

	it("is stable across repeated rebuilds", async () => {
		const couple = await checkInsAcrossAWeekBoundary();
		await couple.do.rebuildCounters(DOM);
		const once = await counters(couple);
		await couple.do.rebuildCounters(DOM);
		expect(await counters(couple)).toEqual(once);
	});
});
