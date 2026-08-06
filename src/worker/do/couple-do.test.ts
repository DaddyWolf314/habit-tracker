import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rungsReached } from "#/shared/counters.ts";
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
			target_direction: "floor",
			daily_target: 5,
			reset: "daily",
			rungs: [],
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
			target_direction: "floor",
			daily_target: 5,
			reset: "daily",
			rungs: [],
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
			target_direction: "floor",
			daily_target: 1,
			reset: "daily",
			rungs: [],
			modify_permission: ["dom", "sub", "switch"],
		});
		const streak = await couple.do.createCounter(DOM, {
			name: "Late arrival streak",
			valence: "positive",
			target_direction: "floor",
			reset: "never",
			streak: { counter: "late_arrival", period: "daily" },
			rungs: [],
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

/**
 * Waiving and reversing (#191, ADR 0016) — the two mechanics end to end, over the
 * pack's R12, whose four effects are exactly the asymmetry this ADR had to state:
 *
 * ```
 * 0: orgasms_unpermitted +1     reversible
 * 1: reset since_last_orgasm    never
 * 2: demerits +2                reversible, unless something reset demerits since
 * 3: reset since_last_infraction never
 * ```
 *
 * #184 deferred all of this to #47 on the grounds that partial reversal would be
 * worse than an honest limit. What changed is not the asymmetry — it is that the
 * asymmetry is now *in the ledger*, as `reversal_declined` rows the couple can
 * read, rather than silent in the model.
 */
describe("waiving an effect (ADR 0016)", () => {
	/** R12's effects, by position — the pair a waiver names. */
	const UNPERMITTED_TALLY = 0;
	const ORGASM_ANCHOR = 1;
	const DEMERITS = 2;

	/** An orgasm logged by the sub, pending the dom's ruling on `permitted`. */
	async function orgasmAwaitingRuling(): Promise<{
		couple: ActiveCouple;
		eventId: string;
	}> {
		const couple = await activeCouple();
		advance(HOUR);
		const event = await couple.do.logEvent(SUB, {
			type: "orgasm",
			metadata: { outcome: "full" },
			subject: couple.subId,
			visibility: "shared",
		});
		return { couple, eventId: event.id };
	}

	/** The trace rows an event produced, by detail kind. */
	async function rowsOfKind(
		couple: ActiveCouple,
		eventId: string,
		kind: string,
	) {
		const rows = await couple.do.getEventTrace(DOM, eventId);
		return rows.filter((row) => row.detail.kind === kind);
	}

	describe("suppressed — waived on the confirm sheet before it lands", () => {
		async function ruledWithDemeritsWaived(): Promise<{
			couple: ActiveCouple;
			eventId: string;
		}> {
			const { couple, eventId } = await orgasmAwaitingRuling();
			advance(HOUR);
			await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: eventId,
				patch: { permitted: false },
				waive: [{ rule_id: "R12", effect_index: DEMERITS }],
			});
			return { couple, eventId };
		}

		it("never applies the effect — the counter holds no peak that never existed", async () => {
			const { couple, eventId } = await ruledWithDemeritsWaived();
			expect((await counters(couple)).demerits).toBe(0);
			// The ruling itself landed, and so did every effect that was not waived.
			expect((await counters(couple)).orgasms_unpermitted).toBe(1);

			// Not fired-then-compensated: there is no counter row on demerits at all,
			// so nothing in the history ever read 2. That is the property that keeps
			// the materialized value provably a cache.
			const rows = await couple.do.getEventTrace(DOM, eventId);
			const demeritMoves = rows.filter(
				(row) =>
					row.projection === "counter:demerits" &&
					row.detail.kind === "counter",
			);
			expect(demeritMoves).toEqual([]);
		});

		it("records both halves in one row: what R12 proposed, and the waiver", async () => {
			const { couple, eventId } = await ruledWithDemeritsWaived();
			const waived = await rowsOfKind(couple, eventId, "waived");
			expect(waived).toHaveLength(1);
			const row = waived[0];
			if (row.detail.kind !== "waived") throw new Error("unreachable");
			expect(row.detail.mechanic).toBe("suppressed");
			expect(row.detail.op).toEqual({
				kind: "counter",
				counter: "demerits",
				op: "increment",
				by: 2,
			});
			// It lands on the counter's own chain, so "why is this not 2" is
			// answerable from the counter the dom waived it on.
			expect(row.projection).toBe("counter:demerits");
			expect(row.cause.by).toBe("amendment");
			if (row.cause.by !== "amendment") throw new Error("unreachable");
			expect(row.cause.rule).toBe("R12");
			expect(row.cause.effect_index).toBe(DEMERITS);
		});

		it("a waived effect is not a near-miss", async () => {
			// The ledger must distinguish "this never applied to you" — a rule that
			// did not match — from "this applied and I let it go". R12 *fired* under
			// the ruling; only one of its effects was withheld.
			//
			// The near-miss R12 does have is the one from *append*, when `permitted`
			// was still unset — the pending signal, written before any of this, and
			// correctly still there. What must not exist is a near-miss written by the
			// ruling, which would say the rule never applied.
			const { couple, eventId } = await ruledWithDemeritsWaived();
			const nearMisses = await rowsOfKind(couple, eventId, "near_miss");
			expect(nearMisses.every((row) => row.cause.by === "rule")).toBe(true);
			expect(
				nearMisses.some(
					(row) => row.cause.by === "rule" && row.cause.rule === "R12",
				),
			).toBe(true);

			const waived = await rowsOfKind(couple, eventId, "waived");
			expect(waived).toHaveLength(1);
			expect(waived[0].detail.kind).not.toBe("near_miss");
			// And the rule's other effects landed, which is what "it fired" means.
			expect((await counters(couple)).orgasms_unpermitted).toBe(1);
		});

		it("stays suppressed on rebuild, with no preserved-state exception", async () => {
			// The waiver is read at the same point in the sequence it was written, so
			// replay withholds the same effect rather than firing and compensating it.
			const { couple, eventId } = await ruledWithDemeritsWaived();
			const live = await counters(couple);
			await couple.do.rebuildCounters(DOM);
			expect(await counters(couple)).toEqual(live);
			expect((await counters(couple)).demerits).toBe(0);
			expect(await rowsOfKind(couple, eventId, "waived")).toHaveLength(1);
		});

		it("refuses a stale sheet naming an effect the ruling would not fire", async () => {
			const { couple, eventId } = await orgasmAwaitingRuling();
			await expect(
				couple.do.amend(DOM, {
					kind: "adjudication",
					target_event_id: eventId,
					patch: { permitted: false },
					waive: [{ rule_id: "R11", effect_index: 0 }],
				}),
			).rejects.toThrow(/does not fire/);
		});

		it("refuses a waiver from the sub", async () => {
			const { couple, eventId } = await orgasmAwaitingRuling();
			await expect(
				couple.do.amend(SUB, {
					kind: "waiver",
					target_event_id: eventId,
					waived: [{ rule_id: "R12", effect_index: DEMERITS }],
				}),
			).rejects.toThrow(/may not waive/);
		});
	});

	describe("reversed — waived after it landed", () => {
		/** A late ritual: R2 fires `demerits +1` at append, with no ruling in play. */
		async function lateRitual(): Promise<{
			couple: ActiveCouple;
			eventId: string;
		}> {
			const couple = await activeCouple();
			advance(HOUR);
			const event = await couple.do.logEvent(SUB, {
				type: "ritual_completed",
				metadata: { late: true },
				subject: couple.subId,
				visibility: "shared",
			});
			expect((await counters(couple)).demerits).toBe(1);
			return { couple, eventId: event.id };
		}

		it("reverses an unconditional effect that fired at append", async () => {
			// There was never a confirm sheet here — R2 needs no ruling — which is the
			// case the standalone entry point exists for.
			const { couple, eventId } = await lateRitual();
			advance(HOUR);
			await couple.do.amend(DOM, {
				kind: "waiver",
				target_event_id: eventId,
				waived: [{ rule_id: "R2", effect_index: 0 }],
			});
			expect((await counters(couple)).demerits).toBe(0);

			const waived = await rowsOfKind(couple, eventId, "waived");
			expect(waived).toHaveLength(1);
			if (waived[0].detail.kind !== "waived") throw new Error("unreachable");
			expect(waived[0].detail.mechanic).toBe("reversed");
			expect(waived[0].detail.from).toBe(1);
			expect(waived[0].detail.to).toBe(0);
		});

		it("replays at its own position, so a rebuild agrees", async () => {
			const { couple, eventId } = await lateRitual();
			advance(HOUR);
			await couple.do.amend(DOM, {
				kind: "waiver",
				target_event_id: eventId,
				waived: [{ rule_id: "R2", effect_index: 0 }],
			});
			const live = await counters(couple);
			await couple.do.rebuildCounters(DOM);
			expect(await counters(couple)).toEqual(live);
			expect((await counters(couple)).demerits).toBe(0);
		});

		it("refuses to waive the same effect twice", async () => {
			const { couple, eventId } = await lateRitual();
			await couple.do.amend(DOM, {
				kind: "waiver",
				target_event_id: eventId,
				waived: [{ rule_id: "R2", effect_index: 0 }],
			});
			await expect(
				couple.do.amend(DOM, {
					kind: "waiver",
					target_event_id: eventId,
					waived: [{ rule_id: "R2", effect_index: 0 }],
				}),
			).rejects.toThrow(/no standing effect/);
		});

		it("is exact across intervening increments and decrements, however many", async () => {
			const { couple, eventId } = await lateRitual();
			// A compensating delta commutes with other deltas, so the number of them
			// is irrelevant — which is the property that lets the check be a scan for
			// non-commuting rows rather than any arithmetic over the ones between.
			for (const delta of [3, -1, 5, -2, 4]) {
				advance(60_000);
				await couple.do.adjustCounter(DOM, "demerits", delta);
			}
			expect((await counters(couple)).demerits).toBe(10);

			advance(HOUR);
			await couple.do.amend(DOM, {
				kind: "waiver",
				target_event_id: eventId,
				waived: [{ rule_id: "R2", effect_index: 0 }],
			});
			expect((await counters(couple)).demerits).toBe(9);
		});
	});

	describe("a correction always lands, and reverses what still commutes", () => {
		/**
		 * The exact case ADR 0016 was written around. R12 puts demerits at 2, the sub
		 * acknowledges and the counter resets to 0, and only then does the dom decide
		 * the ruling was wrong. `applyCounterOp` has no floor, so a naive reversal
		 * prints `demerits: −2` on a screen the sub reads.
		 */
		async function acknowledgedThenCorrected(): Promise<{
			couple: ActiveCouple;
			eventId: string;
		}> {
			const { couple, eventId } = await orgasmAwaitingRuling();
			advance(HOUR);
			const ruled = await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: eventId,
				patch: { permitted: false },
			});
			expect((await counters(couple)).demerits).toBe(2);

			advance(HOUR);
			await couple.do.resetCounter(SUB, "demerits"); // the acknowledgment
			expect((await counters(couple)).demerits).toBe(0);

			advance(HOUR);
			const ruling = ruled.amendments.find((a) => a.kind === "adjudication");
			await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: eventId,
				patch: { permitted: true },
				supersedes: ruling?.id,
			});
			return { couple, eventId };
		}

		it("declines the reversal rather than subtracting from nothing", async () => {
			const { couple, eventId } = await acknowledgedThenCorrected();
			// Not −2. The punishment had already been discharged, and the reversal
			// would have subtracted it from a counter that no longer held it.
			expect((await counters(couple)).demerits).toBe(0);

			const declined = await rowsOfKind(couple, eventId, "reversal_declined");
			const onDemerits = declined.find(
				(row) => row.projection === "counter:demerits",
			);
			if (onDemerits?.detail.kind !== "reversal_declined") {
				throw new Error("no declined row for the demerits reversal");
			}
			expect(onDemerits.detail.reason).toMatch(/reset since/);
		});

		it("still lands the correction itself", async () => {
			// Refusing corrections that cannot be fully reversed would mean the dom
			// could not record that they got R12 wrong *at all*, which is the worst
			// outcome available to a log whose purpose is being an auditable record.
			const { couple, eventId } = await acknowledgedThenCorrected();
			const events = await couple.do.listEvents(DOM);
			const event = events.find((e) => e.id === eventId);
			expect(event?.composite_metadata.permitted).toBe(true);
			// And what the correction newly unlocked fires forward as it always did.
			expect((await counters(couple)).orgasms_permitted).toBe(1);
		});

		it("reproduces the same declined reversal on rebuild", async () => {
			const { couple } = await acknowledgedThenCorrected();
			const live = await counters(couple);
			await couple.do.rebuildCounters(DOM);
			expect(await counters(couple)).toEqual(live);
		});
	});

	describe("a correction reverses the counter and declines the rest", () => {
		/**
		 * A denial running when the orgasm happened, so the wrong ruling reached all
		 * four of R12's effects, R14's timer close, *and* R26's escalation — three
		 * rules, one wrong fact. Correcting it is where the asymmetry is at its
		 * widest: three counter effects reverse, two anchors and a closed countdown
		 * cannot.
		 */
		async function correctedDuringDenial(): Promise<{
			couple: ActiveCouple;
			eventId: string;
		}> {
			const couple = await activeCouple();
			await couple.do.logEvent(DOM, {
				type: "denial_started",
				metadata: { duration_ms: 8 * HOUR },
				subject: couple.subId,
				visibility: "shared",
			});
			advance(HOUR);
			const event = await couple.do.logEvent(SUB, {
				type: "orgasm",
				metadata: { outcome: "full" },
				subject: couple.subId,
				visibility: "shared",
			});
			advance(HOUR);
			const ruled = await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: event.id,
				patch: { permitted: false },
			});
			// R12's +2 and R26's escalation +2 — the denial was running when it
			// happened, so both landed on the same wrong ruling.
			expect((await counters(couple)).demerits).toBe(4);
			expect(couple.timerRows()[0]?.status).toBe("failed");

			advance(HOUR);
			const ruling = ruled.amendments.find((a) => a.kind === "adjudication");
			await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: event.id,
				patch: { permitted: true },
				supersedes: ruling?.id,
			});
			return { couple, eventId: event.id };
		}

		it("reverses both counter effects exactly", async () => {
			const { couple } = await correctedDuringDenial();
			expect((await counters(couple)).demerits).toBe(0);
			expect((await counters(couple)).orgasms_unpermitted).toBe(0);
		});

		it("files a declined row for each anchor and for the countdown", async () => {
			const { couple, eventId } = await correctedDuringDenial();
			const declined = await rowsOfKind(couple, eventId, "reversal_declined");
			const projections = declined.map((row) => row.projection).sort();
			expect(projections).toEqual([
				"anchor:since_last_infraction",
				"anchor:since_last_orgasm",
				"timer:denial_period",
			]);
			// Each says *why*, in the shape a near-miss established — the couple can
			// see exactly what stayed and talk about it, which is the mechanism this
			// app reaches for everywhere it cannot compute an answer.
			for (const row of declined) {
				if (row.detail.kind !== "reversal_declined") {
					throw new Error("unreachable");
				}
				expect(row.detail.reason.length).toBeGreaterThan(0);
			}
		});

		it("leaves the countdown failed — no retroactive timer surgery", async () => {
			// The refusal `couple-do.ts` has made since Phase 4 stands. A closed
			// countdown has no honest inverse, and reopening one would rewrite a span
			// the couple actually lived.
			const { couple } = await correctedDuringDenial();
			expect(couple.timerRows()[0]?.status).toBe("failed");
		});

		it("agrees with a rebuild", async () => {
			const { couple } = await correctedDuringDenial();
			const live = await counters(couple);
			await couple.do.rebuildCounters(DOM);
			expect(await counters(couple)).toEqual(live);
		});

		it("reverses only the rules that stopped matching", async () => {
			// The unconditional rules fired on the same event and are untouched by a
			// correction to `permitted`; reversing them would undo effects the ruling
			// never caused. R12 and R26 both hung on the wrong fact, so both go.
			const { couple, eventId } = await correctedDuringDenial();
			const waived = await rowsOfKind(couple, eventId, "waived");
			const rules = new Set(
				waived.map((row) =>
					row.cause.by === "amendment" ? row.cause.rule : "",
				),
			);
			expect([...rules].sort()).toEqual(["R12", "R26"]);
			expect(waived.map((row) => row.projection).sort()).toEqual([
				"counter:demerits",
				"counter:demerits",
				"counter:orgasms_unpermitted",
			]);
		});

		it("does not reverse the same effect a second time", async () => {
			// Correcting back and forth must not compound: the first correction spent
			// those effects, and the second finds none of them still standing. The
			// rules fire *afresh* instead, so the numbers move forward from where the
			// reversal left them rather than reversing a reversal.
			const { couple, eventId } = await correctedDuringDenial();
			const before = await counters(couple);
			const events = await couple.do.listEvents(DOM);
			const event = events.find((e) => e.id === eventId);
			const latest = event?.amendments
				.filter((a) => a.kind === "adjudication")
				.at(-1);
			advance(HOUR);
			await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: eventId,
				patch: { permitted: false },
				supersedes: latest?.id,
			});
			const after = await counters(couple);
			// R12 alone this time: R14's close stamped the denial's end at the
			// orgasm's own `occurred_at`, so the ambient-state predicate no longer
			// reports a denial running *at* that instant and R26 does not re-fire.
			// That is ADR 0011's clock, unchanged by any of this — what matters here
			// is that nothing reverses twice and the numbers only move forward.
			expect(after.demerits).toBe(before.demerits + 2);
			expect(after.orgasms_unpermitted).toBe(before.orgasms_unpermitted + 1);
		});
	});

	describe("what a rebuild does with a waiver over a re-fired effect", () => {
		it("agrees with live after a correction, a reversal, and a re-fire", async () => {
			// The pairing that makes `standingEffects` per-row rather than per
			// `(rule, index)`: A fires, is reversed by a correction to B, and fires
			// again when the dom corrects back to A. Live and rebuild have to make the
			// same pairing or the second effect is treated as already handled.
			const { couple, eventId } = await orgasmAwaitingRuling();
			advance(HOUR);
			const first = await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: eventId,
				patch: { permitted: false },
			});
			advance(HOUR);
			const firstRuling = first.amendments.find(
				(a) => a.kind === "adjudication",
			);
			const second = await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: eventId,
				patch: { permitted: true },
				supersedes: firstRuling?.id,
			});
			advance(HOUR);
			const secondRuling = second.amendments
				.filter((a) => a.kind === "adjudication")
				.at(-1);
			await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: eventId,
				patch: { permitted: false },
				supersedes: secondRuling?.id,
			});

			const live = await counters(couple);
			expect(live.demerits).toBe(2);
			await couple.do.rebuildCounters(DOM);
			expect(await counters(couple)).toEqual(live);
		});
	});

	describe("a correction touches only the key it corrected", () => {
		/**
		 * The case a single-key ruling cannot reach. `compositeMetadata` drops a
		 * superseded patch **wholesale**, so a ruling that decided two awaited keys
		 * and is corrected on one — the other re-asserted — leaves the second key's
		 * rule matching before *and* after. `unfired` therefore never names it and
		 * `reevaluate` never re-fires it (forward-only), so reversing it off the
		 * superseded ruling's trace rows would strip an effect that nothing would
		 * ever put back.
		 */
		async function ruledOnTwoKeysThenCorrectedOnOne(): Promise<{
			couple: ActiveCouple;
			eventId: string;
		}> {
			const couple = await activeCouple();
			await couple.do.createEventType(DOM, {
				id: "scene_reviewed",
				label: "Scene reviewed",
				valence: "neutral",
				log_permission: ["dom", "sub", "switch"],
				subject_required: true,
				metadata: {
					obedience: {
						kind: "enum",
						options: ["good", "poor"],
						label: "Obedience",
						required: false,
						set_permission: [],
						adjudicated_by: ["dom"],
					},
					service: {
						kind: "enum",
						options: ["good", "poor"],
						label: "Service",
						required: false,
						set_permission: [],
						adjudicated_by: ["dom"],
					},
				},
				awaiting: ["obedience", "service"],
			});
			await couple.do.createRule(DOM, {
				id: "custom-poor-obedience",
				name: "Poor obedience",
				condition: {
					type: "scene_reviewed",
					metadata: { obedience: "poor" },
				},
				effects: [{ verb: "increment_counter", counter: "demerits", by: 3 }],
			});
			await couple.do.createRule(DOM, {
				id: "custom-poor-service",
				name: "Poor service",
				condition: { type: "scene_reviewed", metadata: { service: "poor" } },
				effects: [
					{ verb: "increment_counter", counter: "infractions_lifetime", by: 1 },
				],
			});

			advance(HOUR);
			const event = await couple.do.logEvent(SUB, {
				type: "scene_reviewed",
				metadata: {},
				subject: couple.subId,
				visibility: "shared",
			});
			advance(HOUR);
			// One ruling, both keys — so both rules fire from the same amendment.
			const ruled = await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: event.id,
				patch: { obedience: "poor", service: "poor" },
			});
			expect((await counters(couple)).demerits).toBe(3);
			expect((await counters(couple)).infractions_lifetime).toBe(1);

			advance(HOUR);
			// The dom got *obedience* wrong and says so, re-asserting service.
			const ruling = ruled.amendments.find((a) => a.kind === "adjudication");
			await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: event.id,
				patch: { obedience: "good", service: "poor" },
				supersedes: ruling?.id,
			});
			return { couple, eventId: event.id };
		}

		it("reverses the corrected key's effect", async () => {
			const { couple } = await ruledOnTwoKeysThenCorrectedOnOne();
			expect((await counters(couple)).demerits).toBe(0);
		});

		it("leaves the re-asserted key's effect standing", async () => {
			// The fact it hangs on is still true, and nothing would re-apply it: the
			// rule fired before and fires after, so it is in neither `unfired` nor
			// `reevaluate`'s forward set.
			const { couple } = await ruledOnTwoKeysThenCorrectedOnOne();
			expect((await counters(couple)).infractions_lifetime).toBe(1);
		});

		it("files no waiver row against the rule that still matches", async () => {
			const { couple, eventId } = await ruledOnTwoKeysThenCorrectedOnOne();
			const overruled = (await couple.do.getEventTrace(DOM, eventId)).filter(
				(row) =>
					row.detail.kind === "waived" ||
					row.detail.kind === "reversal_declined",
			);
			const rules = overruled.map((row) =>
				row.cause.by === "amendment" ? row.cause.rule : "",
			);
			expect(rules).not.toContain("custom-poor-service");
			expect(rules).toContain("custom-poor-obedience");
		});

		it("agrees with a rebuild", async () => {
			const { couple } = await ruledOnTwoKeysThenCorrectedOnOne();
			const live = await counters(couple);
			await couple.do.rebuildCounters(DOM);
			expect(await counters(couple)).toEqual(live);
		});
	});

	describe("the anchor effects nothing can undo", () => {
		it("leaves the anchor where the wrong ruling put it", async () => {
			// Stated as its own test because it is the part of #184's asymmetry that
			// this ADR explicitly does *not* dissolve: nothing records what an anchor
			// reset displaced, so there is no inverse to offer.
			const { couple, eventId } = await orgasmAwaitingRuling();
			advance(HOUR);
			const ruled = await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: eventId,
				patch: { permitted: false },
			});
			const anchorAfterRuling = (await couple.do.listAnchors(DOM)).find(
				(a) => a.anchor === "since_last_infraction",
			)?.since;
			expect(anchorAfterRuling).not.toBeNull();

			advance(HOUR);
			const ruling = ruled.amendments.find((a) => a.kind === "adjudication");
			await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: eventId,
				patch: { permitted: true },
				supersedes: ruling?.id,
			});
			const after = (await couple.do.listAnchors(DOM)).find(
				(a) => a.anchor === "since_last_infraction",
			)?.since;
			expect(after).toBe(anchorAfterRuling);
		});

		it("names the individual effects a waiver may target", async () => {
			// The tally and the anchor are different positions on the same rule, and a
			// waiver names one without touching the other.
			const { couple, eventId } = await orgasmAwaitingRuling();
			advance(HOUR);
			await couple.do.amend(DOM, {
				kind: "adjudication",
				target_event_id: eventId,
				patch: { permitted: false },
				waive: [
					{ rule_id: "R12", effect_index: UNPERMITTED_TALLY },
					{ rule_id: "R12", effect_index: ORGASM_ANCHOR },
				],
			});
			expect((await counters(couple)).orgasms_unpermitted).toBe(0);
			expect((await counters(couple)).demerits).toBe(2);
			const anchor = (await couple.do.listAnchors(DOM)).find(
				(a) => a.anchor === "since_last_orgasm",
			);
			// A suppressed anchor reset simply never happens — suppression needs no
			// inverse, which is why it reaches effects reversal never can.
			expect(anchor?.since).toBeNull();
		});
	});
});

/**
 * The counter-value predicate and the routed magnitude at the DO boundary (ADR 0015).
 *
 * The engine tests pin the fold; these pin the two things only the DO can be
 * wrong about — *which* value it hands the engine, and whether a rebuild hands
 * it the same one. Both were the failure mode ADR 0015 wrote the clock rule to
 * avoid: silent, rebuild-only, and in the scoring direction.
 */
describe("counter_value at the DO boundary (ADR 0015)", () => {
	/** The rows of an event's trace, decoded — for asserting on skip notes. */
	async function eventTrace(couple: ActiveCouple, eventId: string) {
		return (await couple.do.getEventTrace(DOM, eventId)).map(
			(row) => row.detail,
		);
	}

	/**
	 * A couple whose infractions both escalate at ten and count toward ten — one
	 * rule reading `demerits` and one writing it, on the same event type.
	 */
	async function ladder(): Promise<ActiveCouple> {
		const couple = await activeCouple();
		await couple.do.createCounter(DOM, {
			name: "Escalations",
			valence: "negative",
			target_direction: "floor",
			reset: "never",
			rungs: [],
			modify_permission: ["dom", "sub", "switch"],
		});
		await couple.do.createRule(DOM, {
			id: "custom-tally",
			name: "Every infraction counts",
			condition: { type: "infraction", metadata: {} },
			effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
		});
		await couple.do.createRule(DOM, {
			id: "custom-escalate",
			name: "Escalate at ten",
			condition: {
				type: "infraction",
				metadata: {},
				counter_value: { demerits: { op: "gte", value: 10 } },
			},
			effects: [{ verb: "increment_counter", counter: "escalations", by: 1 }],
		});
		return couple;
	}

	async function logInfraction(
		couple: ActiveCouple,
		occurredAt: number = Date.now(),
	) {
		return couple.do.logEvent(SUB, {
			type: "infraction",
			metadata: { severity: "minor", self_reported: true },
			subject: couple.subId,
			occurred_at: occurredAt,
			visibility: "shared",
		});
	}

	it("reads the score before the event's own effects", async () => {
		const couple = await ladder();
		// Nine infractions: `demerits` reaches 9 and nothing has escalated.
		for (let i = 0; i < 9; i += 1) {
			advance(HOUR);
			await logInfraction(couple);
		}
		expect(await counters(couple)).toMatchObject({
			demerits: 9,
			escalations: 0,
		});

		// The tenth *crosses* ten. It does not escalate itself: the rule reads the
		// score the act happened against, exactly as `timer_active` reads a denial
		// period the rule beside it is about to close.
		advance(HOUR);
		await logInfraction(couple);
		expect(await counters(couple)).toMatchObject({
			demerits: 10,
			escalations: 0,
		});

		// The next one does.
		advance(HOUR);
		await logInfraction(couple);
		expect(await counters(couple)).toMatchObject({
			demerits: 11,
			escalations: 1,
		});
	});

	it("rebuilds to the same score a backfilled event produced live", async () => {
		// The case the `occurred_at` reading would have broken. The last event is
		// *backfilled* — logged now, but for a moment before every counter move
		// already in the log. Reading the counter as of `occurred_at` would score it
		// against a value the engine never saw, and a replay walking log-time order
		// would then compute something different from live.
		const couple = await ladder();
		const backdated = Date.now();
		for (let i = 0; i < 10; i += 1) {
			advance(HOUR);
			await logInfraction(couple);
		}
		advance(HOUR);
		await logInfraction(couple, backdated - DAY);

		const live = await counters(couple);
		expect(live).toMatchObject({ demerits: 11, escalations: 1 });

		await couple.do.rebuildCounters(DOM);
		expect(await counters(couple)).toEqual(live);
	});

	it("stays stable across repeated rebuilds", async () => {
		const couple = await ladder();
		for (let i = 0; i < 12; i += 1) {
			advance(HOUR);
			await logInfraction(couple);
		}
		await couple.do.rebuildCounters(DOM);
		const once = await counters(couple);
		await couple.do.rebuildCounters(DOM);
		expect(await counters(couple)).toEqual(once);
	});

	it("does not change its answer when the rules are declared the other way round", async () => {
		// Rule order within an event is an authoring accident, and it must not be a
		// semantic one. The context is built once, before any effect lands, so both
		// orders read the same pre-event score.
		async function outcome(escalateFirst: boolean) {
			const couple = await activeCouple();
			await couple.do.createCounter(DOM, {
				name: "Escalations",
				valence: "negative",
				target_direction: "floor",
				reset: "never",
				rungs: [],
				modify_permission: ["dom", "sub", "switch"],
			});
			const tally = {
				id: "custom-tally",
				name: "Every infraction counts",
				condition: { type: "infraction", metadata: {} },
				effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
			} as const;
			const escalate = {
				id: "custom-escalate",
				name: "Escalate at three",
				condition: {
					type: "infraction",
					metadata: {},
					counter_value: { demerits: { op: "gte", value: 3 } },
				},
				effects: [{ verb: "increment_counter", counter: "escalations", by: 1 }],
			} as const;
			for (const rule of escalateFirst
				? [escalate, tally]
				: [tally, escalate]) {
				await couple.do.createRule(DOM, rule);
			}
			for (let i = 0; i < 4; i += 1) {
				advance(HOUR);
				await logInfraction(couple);
			}
			return counters(couple);
		}
		const tallyFirst = await outcome(false);
		const escalateFirst = await outcome(true);
		expect(escalateFirst).toEqual(tallyFirst);
		expect(tallyFirst).toMatchObject({ demerits: 4, escalations: 1 });
	});

	it("skips a routed magnitude with nothing to route, and says so", async () => {
		const couple = await activeCouple();
		await couple.do.createEventType(DOM, {
			id: "penalty",
			label: "Penalty",
			valence: "negative",
			log_permission: ["dom", "switch"],
			subject_required: true,
			metadata: {
				// Whole and floored at zero — the two things a routed magnitude's
				// field must declare (ADR 0015). Optional, which is what makes the
				// skip below reachable at all.
				weight: {
					kind: "number",
					integer: true,
					min: 0,
					label: "Weight",
					required: false,
					set_permission: ["dom", "switch"],
				},
			},
			awaiting: [],
		});
		await couple.do.createRule(DOM, {
			id: "custom-weighted",
			name: "Weighted penalty",
			condition: { type: "penalty", metadata: {} },
			effects: [
				{
					verb: "increment_counter",
					counter: "demerits",
					by: 1,
					by_from: "weight",
				},
			],
		});

		advance(HOUR);
		const routed = await couple.do.logEvent(DOM, {
			type: "penalty",
			metadata: { weight: 3 },
			subject: couple.subId,
			visibility: "shared",
		});
		expect((await counters(couple)).demerits).toBe(3);
		expect(await eventTrace(couple, routed.id)).toContainEqual(
			expect.objectContaining({ kind: "counter", by: 3, from: 0, to: 3 }),
		);

		// The optional field left blank — the case that cannot move to authoring
		// time. The counter does not move at all: not by `by`, which would print
		// `+1` for a rule its author believed was proportional.
		advance(HOUR);
		const blank = await couple.do.logEvent(DOM, {
			type: "penalty",
			metadata: {},
			subject: couple.subId,
			visibility: "shared",
		});
		expect((await counters(couple)).demerits).toBe(3);
		expect(await eventTrace(couple, blank.id)).toContainEqual({
			kind: "counter_skipped",
			reason: "custom-weighted skipped: no whole number at 'weight'",
			op: "increment",
			key: "weight",
		});

		// And the skip replays: a rebuild files the same note and moves nothing.
		await couple.do.rebuildCounters(DOM);
		expect((await counters(couple)).demerits).toBe(3);
		expect(await eventTrace(couple, blank.id)).toContainEqual(
			expect.objectContaining({ kind: "counter_skipped" }),
		);
	});

	/**
	 * Both ways a field can fail to be a magnitude, refused at the DO boundary
	 * rather than at runtime (ADR 0015) — so the refusal is proven to reach
	 * `createRule` and not merely to exist in `validateRule`.
	 */
	async function coupleWithMeasured(
		declared: Record<string, unknown>,
	): Promise<ActiveCouple> {
		const couple = await activeCouple();
		await couple.do.createEventType(DOM, {
			id: "measured",
			label: "Measured",
			valence: "neutral",
			log_permission: ["dom", "switch"],
			subject_required: false,
			metadata: {
				amount: {
					kind: "number",
					label: "Amount",
					required: false,
					set_permission: ["dom", "switch"],
					...declared,
				},
			},
			awaiting: [],
		});
		return couple;
	}

	function measuredRule(couple: ActiveCouple) {
		return couple.do.createRule(DOM, {
			id: "custom-measured",
			name: "Measured penalty",
			condition: { type: "measured", metadata: {} },
			effects: [
				{
					verb: "increment_counter",
					counter: "demerits",
					by: 1,
					by_from: "amount",
				},
			],
		});
	}

	it("refuses a fractional routed magnitude at rule creation, not at runtime", async () => {
		const couple = await coupleWithMeasured({ min: 0 });
		await expect(measuredRule(couple)).rejects.toThrow(/declared integer/);
	});

	it("refuses a routed magnitude whose field permits a negative", async () => {
		// The verb carries the direction. Without a declared floor, `amount: -3`
		// would make this `increment_counter` subtract — the rule's own verb and
		// the counter disagreeing, with the logger overriding the rule's author.
		const couple = await coupleWithMeasured({ integer: true });
		await expect(measuredRule(couple)).rejects.toThrow(/min 0 or higher/);
	});

	it("accepts one whose field is whole and floored at zero", async () => {
		const couple = await coupleWithMeasured({ integer: true, min: 0 });
		await expect(measuredRule(couple)).resolves.toBeDefined();
	});
});

/**
 * A cap target (ADR 0015) — the mercy counterpart, and the reason the ADR could
 * refuse an anchor clause. Without it there is no clean-streak counter for a
 * `counter_value` clause to read.
 */
describe("a cap target folds a clean streak", () => {
	async function cleanStreak(): Promise<ActiveCouple> {
		const couple = await activeCouple();
		// "Infractions today", capped at zero and cleared each day: met by a day
		// with none, which a floor target could never express.
		await couple.do.createCounter(DOM, {
			name: "Infractions today",
			valence: "negative",
			daily_target: 0,
			target_direction: "cap",
			reset: "daily",
			rungs: [],
			modify_permission: ["dom", "sub", "switch"],
		});
		await couple.do.createCounter(DOM, {
			name: "Clean days",
			valence: "positive",
			target_direction: "floor",
			reset: "never",
			streak: { counter: "infractions_today", period: "daily" },
			rungs: [],
			modify_permission: ["dom", "sub", "switch"],
		});
		await couple.do.createRule(DOM, {
			id: "custom-count-infractions",
			name: "Count today's infractions",
			condition: { type: "infraction", metadata: {} },
			effects: [
				{ verb: "increment_counter", counter: "infractions_today", by: 1 },
			],
		});
		return couple;
	}

	it("grows across a quiet week and breaks on the first infraction", async () => {
		const couple = await cleanStreak();

		// Seven quiet days. A floor target of 0 would be trivially met and so would
		// look identical here — the next assertion is what separates them.
		await advanceFiringAlarms(couple, 7 * DAY);
		expect((await counters(couple)).clean_days).toBe(7);

		// One infraction, then the boundary: the cap is exceeded, so the fold
		// breaks the streak rather than continuing it.
		await couple.do.logEvent(SUB, {
			type: "infraction",
			metadata: { severity: "minor", self_reported: true },
			subject: couple.subId,
			visibility: "shared",
		});
		expect((await counters(couple)).infractions_today).toBe(1);
		await advanceFiringAlarms(couple, DAY);
		expect((await counters(couple)).clean_days).toBe(0);

		// And it starts over from the next quiet day, so the mercy path is a path.
		await advanceFiringAlarms(couple, DAY);
		expect((await counters(couple)).clean_days).toBe(1);
	});

	it("rebuilds the same streak it folded live", async () => {
		const couple = await cleanStreak();
		await advanceFiringAlarms(couple, 3 * DAY);
		await couple.do.logEvent(SUB, {
			type: "infraction",
			metadata: { severity: "minor", self_reported: true },
			subject: couple.subId,
			visibility: "shared",
		});
		await advanceFiringAlarms(couple, 2 * DAY);
		const live = await counters(couple);

		await couple.do.rebuildCounters(DOM);
		// The fold resolves the direction off the counter version in force for each
		// boundary (ADR 0013), so a replay scores each past day the way the couple
		// actually lived it.
		expect(await counters(couple)).toEqual(live);
	});
});

/**
 * Rungs, and the crossings they announce (#193, ADR 0015).
 *
 * The property under test is that a crossing is a **recorded moment** resolved on
 * two clocks that already existed: the ladder off the counter version in force at
 * the move's log-time, the cited term off the causing event's `occurred_at`. Get
 * either wrong and the failure is silent and retroactive — a ladder edited today
 * rewriting what last week announced — which is the exact failure ADR 0013 gave
 * counters a version history to prevent.
 */
describe("rung crossings", () => {
	/** A term to cite, authored by the dom about the sub (`counterpart` scope). */
	async function term(couple: ActiveCouple, name: string): Promise<string> {
		const agreement = await couple.do.createAgreement(DOM, {
			kind: "protocol",
			name,
			text: `What ${name} costs.`,
		});
		return agreement.id;
	}

	/** Puts a ladder on an existing pack counter, leaving its policy otherwise as-is. */
	async function setRungs(
		couple: ActiveCouple,
		counterId: string,
		rungs: { at: number; agreement_ref: string }[],
	): Promise<void> {
		const existing = (await couple.do.listCounters(DOM)).find(
			(counter) => counter.id === counterId,
		);
		if (!existing) throw new Error(`no counter ${counterId}`);
		const {
			id: _id,
			value: _value,
			updated_at: _updatedAt,
			...policy
		} = existing;
		await couple.do.updateCounter(DOM, counterId, { ...policy, rungs });
	}

	/** Every crossing row in the ledger, oldest first. */
	function crossings(couple: ActiveCouple) {
		return (
			couple.db
				.prepare(`SELECT at, projection, detail FROM trace ORDER BY id ASC`)
				.all() as { at: number; projection: string; detail: string }[]
		)
			.map((row) => ({
				at: row.at,
				projection: row.projection,
				detail: JSON.parse(row.detail) as Record<string, unknown>,
			}))
			.filter((row) => row.detail.kind === "crossing");
	}

	/** `demerits` with a rung at 10, and the term that rung cites. */
	async function ladder(): Promise<{
		couple: ActiveCouple;
		agreementId: string;
	}> {
		const couple = await activeCouple();
		const agreementId = await term(couple, "Ten demerits");
		await setRungs(couple, "demerits", [
			{ at: 10, agreement_ref: agreementId },
		]);
		return { couple, agreementId };
	}

	it("files a row on the way up, naming the rung and the term it cites", async () => {
		const { couple, agreementId } = await ladder();
		advance(HOUR);
		await couple.do.adjustCounter(DOM, "demerits", 9);
		expect(crossings(couple)).toHaveLength(0);

		await couple.do.adjustCounter(DOM, "demerits", 1);
		const filed = crossings(couple);
		expect(filed).toHaveLength(1);
		expect(filed[0].projection).toBe("counter:demerits");
		expect(filed[0].detail).toMatchObject({
			kind: "crossing",
			rung: 10,
			agreement_ref: agreementId,
			from: 9,
			to: 10,
		});
	});

	it("files two rows for 10, a reset, and 10 again", async () => {
		// The issue's headline case. Landing exactly on the rung crosses it, and
		// arriving there a second time is a second moment — the row is history, not
		// a flag that has already been raised.
		const { couple } = await ladder();
		await couple.do.adjustCounter(DOM, "demerits", 10);
		advance(HOUR);
		await couple.do.resetCounter(DOM, "demerits");
		advance(HOUR);
		await couple.do.adjustCounter(DOM, "demerits", 10);

		const filed = crossings(couple);
		expect(filed).toHaveLength(2);
		expect(filed.map((row) => row.detail.to)).toEqual([10, 10]);
	});

	it("announces nothing going down, or standing still above the rung", async () => {
		const { couple } = await ladder();
		await couple.do.adjustCounter(DOM, "demerits", 12);
		expect(crossings(couple)).toHaveLength(1);

		// Down through the rung: not a moment. The banner clears because the value
		// says so; the row above stays because it happened.
		await couple.do.adjustCounter(DOM, "demerits", -5);
		// And back up from 7 to 9 — still short of it.
		await couple.do.adjustCounter(DOM, "demerits", 2);
		expect(crossings(couple)).toHaveLength(1);
	});

	it("files one row per rung a single move passes", async () => {
		const couple = await activeCouple();
		const three = await term(couple, "Three");
		const five = await term(couple, "Five");
		await setRungs(couple, "demerits", [
			{ at: 3, agreement_ref: three },
			{ at: 5, agreement_ref: five },
		]);
		await couple.do.adjustCounter(DOM, "demerits", 6);

		// Each names a different term the couple agreed, so neither can stand in
		// for the other.
		expect(crossings(couple).map((row) => row.detail.rung)).toEqual([3, 5]);
	});

	it("announces a crossing a rule's effect caused", async () => {
		// The other write path: R2 fires `demerits +1` on a late ritual at append.
		const { couple } = await ladder();
		await couple.do.adjustCounter(DOM, "demerits", 9);
		advance(HOUR);
		const event = await couple.do.logEvent(SUB, {
			type: "ritual_completed",
			metadata: { late: true },
			subject: couple.subId,
			visibility: "shared",
		});

		const filed = crossings(couple);
		expect(filed).toHaveLength(1);
		// The term resolves at the *event's* `occurred_at`, not the row's log-time:
		// two clocks, and the row carries the one the corpus is read on (ADR 0006).
		expect(filed[0].detail.occurred_at).toBe(event.occurred_at);
	});

	it("does not retroactively announce a crossing that predates the rung", async () => {
		// A ladder written today says nothing about last week. The version in force
		// at each move's log-time is the whole mechanism, and a rebuild is where a
		// mistake here would surface — it is the only thing that re-derives the
		// ledger from scratch.
		const couple = await activeCouple();
		await couple.do.adjustCounter(DOM, "demerits", 10);
		expect(crossings(couple)).toHaveLength(0);

		advance(7 * DAY);
		const agreementId = await term(couple, "Ten demerits");
		await setRungs(couple, "demerits", [
			{ at: 10, agreement_ref: agreementId },
		]);
		await couple.do.rebuildCounters(DOM);

		expect(crossings(couple)).toHaveLength(0);
	});

	it("resolves a rung on a reset: never counter, which has no boundary", async () => {
		// The case that made ADR 0015 amend ADR 0013's scope. `infractions_lifetime`
		// never rolls over, so the boundary clock has no moment to offer it at all —
		// only the move's own log-time can resolve the ladder.
		const couple = await activeCouple();
		const agreementId = await term(couple, "Fifth infraction");
		await setRungs(couple, "infractions_lifetime", [
			{ at: 5, agreement_ref: agreementId },
		]);
		for (let n = 0; n < 5; n += 1) {
			advance(HOUR);
			await couple.do.logEvent(SUB, {
				type: "infraction",
				metadata: { severity: "minor", self_reported: true },
				subject: couple.subId,
				visibility: "shared",
			});
		}

		const filed = crossings(couple).filter(
			(row) => row.projection === "counter:infractions_lifetime",
		);
		expect(filed).toHaveLength(1);
		expect(filed[0].detail).toMatchObject({ rung: 5, to: 5 });
	});

	it("keeps the row when a reversal drops the counter back below", async () => {
		// ADR 0016 meets ADR 0015: the recorded crossing stays, because it happened;
		// the standing state is false, because the counter is no longer there.
		const { couple } = await ladder();
		await couple.do.adjustCounter(DOM, "demerits", 9);
		advance(HOUR);
		const event = await couple.do.logEvent(SUB, {
			type: "ritual_completed",
			metadata: { late: true },
			subject: couple.subId,
			visibility: "shared",
		});
		expect((await counters(couple)).demerits).toBe(10);
		expect(crossings(couple)).toHaveLength(1);

		advance(HOUR);
		await couple.do.amend(DOM, {
			kind: "waiver",
			target_event_id: event.id,
			waived: [{ rule_id: "R2", effect_index: 0 }],
		});

		expect((await counters(couple)).demerits).toBe(9);
		// Nothing re-fires on a reversal, in either direction: the compensating move
		// applies an op and evaluates nothing.
		expect(crossings(couple)).toHaveLength(1);
		const demerits = (await couple.do.listCounters(DOM)).find(
			(counter) => counter.id === "demerits",
		);
		if (!demerits) throw new Error("no demerits counter");
		expect(rungsReached(demerits.rungs, demerits.value)).toEqual([]);
	});

	it("rebuilds the crossing rows exactly", async () => {
		const { couple } = await ladder();
		await couple.do.adjustCounter(DOM, "demerits", 4);
		advance(HOUR);
		await couple.do.logEvent(SUB, {
			type: "ritual_completed",
			metadata: { late: true },
			subject: couple.subId,
			visibility: "shared",
		});
		advance(HOUR);
		await couple.do.adjustCounter(DOM, "demerits", 6);
		advance(HOUR);
		await couple.do.resetCounter(DOM, "demerits");
		advance(HOUR);
		await couple.do.adjustCounter(DOM, "demerits", 11);
		const live = crossings(couple);
		expect(live).toHaveLength(2);

		await couple.do.rebuildCounters(DOM);

		// Same rows, same stamps, same rungs — the replay resolves the ladder off
		// the log-time it is already walking, so it cannot drift.
		expect(crossings(couple)).toEqual(live);
	});

	it("counts a crossing for both members until each looks", async () => {
		const { couple } = await ladder();
		await couple.do.adjustCounter(DOM, "demerits", 10);

		// Both, unfiltered by actor — the dom moved the counter and is still told,
		// because a ladder binds the pair (ADR 0015).
		const before = await couple.do.notificationCount(DOM);
		const subBefore = await couple.do.notificationCount(SUB);
		expect(before.unread).toBeGreaterThan(0);
		expect(subBefore.unread).toBeGreaterThan(0);

		advance(HOUR);
		await couple.do.ackCrossings(DOM);
		const after = await couple.do.notificationCount(DOM);
		expect(after.unread).toBe(before.unread - 1);
		// One member looking does not clear the other's.
		expect((await couple.do.notificationCount(SUB)).unread).toBe(
			subBefore.unread,
		);
	});

	it("announces a streak crossing the rollover fold caused", async () => {
		// The third write path, and the one the boundary clock actually serves: a
		// streak climbs at a rollover, so the fold is where it crosses. The ladder is
		// read off the policy already resolved for that boundary, which is the same
		// moment the move is stamped with.
		const couple = await activeCouple();
		const agreementId = await term(couple, "Three days running");
		await setRungs(couple, "ritual_streak_days", [
			{ at: 3, agreement_ref: agreementId },
		]);

		for (let day = 0; day < 3; day += 1) {
			await couple.do.logEvent(SUB, {
				type: "ritual_completed",
				metadata: {},
				subject: couple.subId,
				visibility: "shared",
			});
			await advanceFiringAlarms(couple, DAY);
		}
		expect((await counters(couple)).ritual_streak_days).toBe(3);

		const filed = crossings(couple).filter(
			(row) => row.projection === "counter:ritual_streak_days",
		);
		expect(filed).toHaveLength(1);
		// A system job has no causing event, so the moment the term is read against
		// is the boundary itself — the same stamp the fold carries.
		expect(filed[0].detail).toMatchObject({ rung: 3, from: 2, to: 3 });
		expect(filed[0].detail.occurred_at).toBe(filed[0].at);

		// And a period reset, which only ever moves a counter down, announces nothing.
		expect(
			crossings(couple).filter(
				(row) => row.projection === "counter:rituals_completed_today",
			),
		).toEqual([]);
	});

	it("announces nothing when a reset climbs back to zero from below", () => {
		// A counter has no floor (`applyCounterEvent` is `value + delta`), so a reset
		// from −3 is an *upward* move — and a reset is a clearing, never a crossing.
		// The scheduled reset at a rollover is silent by construction; the direct one
		// has to say so, or the same act announces or doesn't depending on which
		// clock cleared the counter.
		return (async () => {
			const couple = await activeCouple();
			const agreementId = await term(couple, "Back to zero");
			await setRungs(couple, "demerits", [
				{ at: 0, agreement_ref: agreementId },
			]);
			await couple.do.adjustCounter(DOM, "demerits", -3);
			advance(HOUR);
			await couple.do.resetCounter(DOM, "demerits");

			expect((await counters(couple)).demerits).toBe(0);
			expect(crossings(couple)).toEqual([]);
		})();
	});

	it("refuses a rung citing an agreement the couple doesn't hold", async () => {
		const couple = await activeCouple();
		await expect(
			setRungs(couple, "demerits", [{ at: 10, agreement_ref: "ag_nope" }]),
		).rejects.toThrow(/doesn't hold/);
	});
});
