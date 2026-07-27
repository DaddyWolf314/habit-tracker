import { describe, expect, it } from "vitest";
import type { VersionedAgreement } from "./agreements.ts";
import type { MetadataField } from "./event-types.ts";
import { refCandidates } from "./ref-candidates.ts";
import type { Rule } from "./rules.ts";
import type { TimerView } from "./timers.ts";

/**
 * Ref candidates (#89, CONTEXT §Ref). The unit under test is the derivation
 * only: which timers a given event type's ref key can legitimately name, read
 * off the couple's own rules rather than a hardcoded key list. A rule that
 * *closes* a timer by matching a metadata key is exactly the statement "this is
 * an echoing ref" — so `session_ended.session_id` offers the running stopwatches
 * while `session_started.session_id` (an originating ref) offers nothing and
 * stays free text.
 */

const NOW = 1_700_000_000_000;

function timer(overrides: Partial<TimerView> = {}): TimerView {
	return {
		id: "t1",
		kind: "stopwatch",
		timer: "session_stopwatch",
		tag: null,
		match: {},
		opened_at: NOW - 60_000,
		closed_at: null,
		status: null,
		duration_ms: null,
		deadline_at: null,
		paused_at: null,
		remaining_ms: null,
		...overrides,
	};
}

/** R16's shape: `session_ended` closes the stopwatch matching its `session_id`. */
const CLOSE_SESSION: Rule = {
	id: "R16",
	enabled: true,
	condition: { type: "session_ended", metadata: {} },
	effects: [
		{
			verb: "close_timer",
			timer: "session_stopwatch",
			match_on: { session_id: "session_id" },
			status: "completed",
		},
	],
};

/** R15's shape: `session_started` *opens* the stopwatch — an originating ref. */
const OPEN_SESSION: Rule = {
	id: "R15",
	enabled: true,
	condition: { type: "session_started", metadata: {} },
	effects: [
		{
			verb: "open_timer",
			timer: "session_stopwatch",
			match_on: { session_id: "session_id" },
			tag_from: "activity",
		},
	],
};

/** R4's shape: `task_completed` closes the countdown matching its `task_id`. */
const CLOSE_TASK: Rule = {
	id: "R4",
	enabled: true,
	condition: { type: "task_completed", metadata: {} },
	effects: [
		{
			verb: "close_timer",
			timer: "task_countdown",
			match_on: { task_id: "task_id" },
			status: "completed",
		},
	],
};

const RULES = [CLOSE_SESSION, OPEN_SESSION, CLOSE_TASK];

/** An ordinary echoing ref — the flavor most of these tests are about. */
const ECHOING_FIELD: MetadataField = {
	kind: "ref",
	ref_kind: "session",
	label: "Session",
	required: false,
	set_permission: ["dom", "sub", "switch"],
};

/**
 * `refCandidates` requires the field it is offering for, so that no production
 * caller can silently omit it. These tests mostly predate citing refs and are
 * not about the field, so they take the echoing default; the citing tests below
 * pass their own, which wins through the spread.
 */
const offer = (
	args: Omit<Parameters<typeof refCandidates>[0], "field"> & {
		field?: MetadataField;
	},
) => refCandidates({ field: ECHOING_FIELD, ...args });

describe("refCandidates", () => {
	it("offers the running stopwatches a session_ended could close", () => {
		const candidates = offer({
			rules: RULES,
			timers: [
				timer({ id: "t1", tag: "kneeling", match: { session_id: "s1" } }),
			],
			typeId: "session_ended",
			key: "session_id",
			now: NOW,
		});

		expect(candidates).toEqual([{ value: "s1", label: "kneeling — 1m 0s" }]);
	});

	it("offers nothing for an originating ref", () => {
		// `session_started` opens the stopwatch; naming an already-running session
		// would double-open the same id, so the field stays free text.
		expect(
			offer({
				rules: RULES,
				timers: [timer({ tag: "kneeling", match: { session_id: "s1" } })],
				typeId: "session_started",
				key: "session_id",
				now: NOW,
				field: { ...ECHOING_FIELD, minted: true },
			}),
		).toEqual([]);
	});

	it("offers nothing for a key no rule matches a timer on", () => {
		// An echoing ref's candidates are derived from the rules: a key no rule
		// closes a timer on names nothing the engine holds a row for, so free text
		// stands. (`ritual_id` and `rule_ref` used to be the examples here; they
		// are citing refs now and draw from the corpus instead — #121.)
		expect(
			offer({
				rules: RULES,
				timers: [timer({ match: { session_id: "s1" } })],
				typeId: "session_ended",
				key: "unmatched_id",
				now: NOW,
				field: { ...ECHOING_FIELD, ref_kind: "unmatched" },
			}),
		).toEqual([]);
	});

	it("labels a countdown with the time it has left", () => {
		const candidates = offer({
			rules: RULES,
			timers: [
				timer({
					kind: "countdown",
					timer: "task_countdown",
					match: { task_id: "dishes" },
					deadline_at: NOW + 12 * 60_000,
				}),
			],
			typeId: "task_completed",
			key: "task_id",
			now: NOW,
		});

		expect(candidates).toEqual([
			{ value: "dishes", label: "dishes — 12m 0s left" },
		]);
	});

	it("labels a countdown past its deadline overdue, and a paused one paused", () => {
		const overdue = timer({
			id: "t1",
			kind: "countdown",
			timer: "task_countdown",
			match: { task_id: "dishes" },
			deadline_at: NOW - 1,
		});
		const paused = timer({
			id: "t2",
			kind: "countdown",
			timer: "task_countdown",
			match: { task_id: "laundry" },
			deadline_at: NOW + 60_000,
			paused_at: NOW - 1_000,
			remaining_ms: 60_000,
		});

		expect(
			offer({
				rules: RULES,
				timers: [overdue, paused],
				typeId: "task_completed",
				key: "task_id",
				now: NOW,
			}),
		).toEqual([
			{ value: "dishes", label: "dishes — overdue" },
			{ value: "laundry", label: "laundry — 1m 0s left (paused)" },
		]);
	});

	it("leaves out timers that were resolved", () => {
		// A completed, canceled, or failed timer can't be closed again — offering
		// it would hand the author a ref whose close silently matches nothing.
		expect(
			offer({
				rules: RULES,
				timers: [
					timer({ id: "t1", status: "completed", closed_at: NOW - 1_000 }),
					timer({ id: "t2", status: "canceled", closed_at: NOW - 1_000 }),
					timer({ id: "t3", status: "auto_closed", closed_at: NOW - 1_000 }),
				].map((t, i) => ({ ...t, match: { session_id: `s${i}` } })),
				typeId: "session_ended",
				key: "session_id",
				now: NOW,
			}),
		).toEqual([]);
	});

	it("still offers a recently expired countdown, marked overdue", () => {
		// The moment a deadline passes, `listTimers` sweeps the row to `expired` —
		// so filtering on open alone would drop the task from the picker exactly
		// when the sub is late and most likely to mistype it. A late completion
		// still pairs for history (#102's reasoning for a late journal answer).
		// Swept or not, it reads the same word: the sweep is not the author's
		// doing and they cannot see it happen.
		const expired = timer({
			kind: "countdown",
			timer: "task_countdown",
			match: { task_id: "dishes" },
			deadline_at: NOW - 60_000,
			status: "expired",
			closed_at: NOW - 60_000,
		});

		expect(
			offer({
				rules: RULES,
				timers: [expired],
				typeId: "task_completed",
				key: "task_id",
				now: NOW,
			}),
		).toEqual([{ value: "dishes", label: "dishes — overdue" }]);
	});

	it("drops a countdown that expired long ago", () => {
		// The grace runs out: a task from months back is history, not a candidate.
		const stale = timer({
			kind: "countdown",
			timer: "task_countdown",
			match: { task_id: "dishes" },
			deadline_at: NOW - 90 * 24 * 60 * 60 * 1_000,
			status: "expired",
			closed_at: NOW - 90 * 24 * 60 * 60 * 1_000,
		});

		expect(
			offer({
				rules: RULES,
				timers: [stale],
				typeId: "task_completed",
				key: "task_id",
				now: NOW,
			}),
		).toEqual([]);
	});

	it("ignores a disabled rule", () => {
		expect(
			offer({
				rules: [{ ...CLOSE_SESSION, enabled: false }],
				timers: [timer({ tag: "kneeling", match: { session_id: "s1" } })],
				typeId: "session_ended",
				key: "session_id",
				now: NOW,
			}),
		).toEqual([]);
	});

	it("reads the timer-side key when the match renames it", () => {
		// `match_on` is timer key → event key; a rule may pair `timer.slot` with
		// `event.session_id`, and the value to echo lives under the timer's name.
		const renamed: Rule = {
			...CLOSE_SESSION,
			effects: [
				{
					verb: "close_timer",
					timer: "session_stopwatch",
					match_on: { slot: "session_id" },
					status: "completed",
				},
			],
		};

		expect(
			offer({
				rules: [renamed],
				timers: [
					timer({ tag: "kneeling", match: { slot: "s1", session_id: "nope" } }),
				],
				typeId: "session_ended",
				key: "session_id",
				now: NOW,
			}),
		).toEqual([{ value: "s1", label: "kneeling — 1m 0s" }]);
	});

	it("skips a timer that pinned no value for the key", () => {
		expect(
			offer({
				rules: RULES,
				timers: [
					timer({ id: "t1", match: {} }),
					timer({ id: "t2", match: { session_id: "" } }),
				],
				typeId: "session_ended",
				key: "session_id",
				now: NOW,
			}),
		).toEqual([]);
	});

	it("labels a colliding ref from the row a close would discharge", () => {
		// Two tasks named "dishes" open at once — possible while a `task_id` is a
		// hand-typed name (ADR 0005 mints them instead). A close resolves
		// oldest-open-wins, so the option must describe the *older* countdown, not
		// whichever row the API happened to return first (it returns newest first).
		const newer = timer({
			id: "t1",
			kind: "countdown",
			timer: "task_countdown",
			match: { task_id: "dishes" },
			opened_at: NOW - 60_000,
			deadline_at: NOW + 27 * 60 * 60_000,
		});
		const older = timer({
			id: "t2",
			kind: "countdown",
			timer: "task_countdown",
			match: { task_id: "dishes" },
			opened_at: NOW - 9 * 60 * 60_000,
			deadline_at: NOW + 3 * 60 * 60_000,
		});

		expect(
			offer({
				rules: RULES,
				timers: [newer, older],
				typeId: "task_completed",
				key: "task_id",
				now: NOW,
			}),
		).toEqual([{ value: "dishes", label: "dishes — 3h 0m left" }]);
	});

	it("offers one option per distinct ref, disambiguating equal labels", () => {
		// Two sessions of the same activity read identically off their tag; the
		// tail of the id is what tells the author which row they are closing.
		const candidates = offer({
			rules: RULES,
			timers: [
				timer({
					id: "t1",
					tag: "kneeling",
					match: { session_id: "sess-aaaa" },
				}),
				timer({
					id: "t2",
					tag: "kneeling",
					match: { session_id: "sess-bbbb" },
				}),
				timer({
					id: "t3",
					tag: "kneeling",
					match: { session_id: "sess-aaaa" },
				}),
			],
			typeId: "session_ended",
			key: "session_id",
			now: NOW,
		});

		expect(candidates).toEqual([
			{ value: "sess-aaaa", label: "kneeling — 1m 0s · …aaaa" },
			{ value: "sess-bbbb", label: "kneeling — 1m 0s · …bbbb" },
		]);
	});
});

/**
 * Citing refs (#121, ADR 0006). Their candidates are the Agreements *in force* —
 * the opposite lifecycle from an echoing ref's, whose candidates are open timers
 * and which drops a row the moment it resolves. A retired Agreement leaves the
 * picker while every citation already made against it still resolves.
 */
describe("citing-ref candidates", () => {
	const MAR = 1_700_000_000_000;
	const JUN = MAR + 90 * 86_400_000;

	const term = (
		id: string,
		kind: string,
		name: string,
		retiredAt?: number,
	): VersionedAgreement => ({
		id,
		kind,
		versions: [
			{ effective_from: MAR, name, text: "", retired: false },
			...(retiredAt
				? [{ effective_from: retiredAt, name, text: "", retired: true }]
				: []),
		],
	});

	const AGREEMENTS = [
		term("ag_1", "protocol", "ask before you come"),
		term("ag_2", "ritual", "morning kneel"),
		term("ag_3", "ritual", "evening check-in", JUN),
	];

	const citing = (agreementKind?: string): MetadataField => ({
		kind: "ref",
		ref_kind: "agreement",
		...(agreementKind ? { agreement_kind: agreementKind } : {}),
		label: "Agreement",
		required: false,
		set_permission: ["dom", "sub", "switch"],
	});

	it("offers every term in force when the field names no kind", () => {
		// An infraction can cite anything the couple agreed — a protocol, a ritual,
		// a limit — so an unnarrowed field offers the whole corpus.
		const got = offer({
			rules: [],
			timers: [],
			typeId: "infraction",
			key: "rule_ref",
			now: MAR + 1,
			field: citing(),
			agreements: AGREEMENTS,
		});
		expect(got.map((c) => c.value)).toEqual(["ag_1", "ag_2", "ag_3"]);
	});

	it("narrows to one kind when the field names one", () => {
		// Logging a completed ritual should not offer the couple's limits.
		const got = offer({
			rules: [],
			timers: [],
			typeId: "ritual_completed",
			key: "ritual_id",
			now: MAR + 1,
			field: citing("ritual"),
			agreements: AGREEMENTS,
		});
		expect(got.map((c) => c.value)).toEqual(["ag_2", "ag_3"]);
	});

	it("stops offering a retired term", () => {
		const got = offer({
			rules: [],
			timers: [],
			typeId: "ritual_completed",
			key: "ritual_id",
			now: JUN + 1,
			field: citing("ritual"),
			agreements: AGREEMENTS,
		});
		expect(got.map((c) => c.value)).toEqual(["ag_2"]);
	});

	it("labels a candidate by the name in force, not the current one", () => {
		// Same reason a citation renders the old name: what the term was called
		// then is what the person agreed to.
		const renamed: VersionedAgreement = {
			id: "ag_9",
			kind: "protocol",
			versions: [
				{ effective_from: MAR, name: "old name", text: "", retired: false },
				{ effective_from: JUN, name: "new name", text: "", retired: false },
			],
		};
		const at = (now: number) =>
			offer({
				rules: [],
				timers: [],
				typeId: "infraction",
				key: "rule_ref",
				now,
				field: citing(),
				agreements: [renamed],
			})[0]?.label;
		expect(at(MAR + 1)).toBe("old name");
		expect(at(JUN + 1)).toBe("new name");
	});

	it("falls back to free text when the corpus is empty", () => {
		expect(
			offer({
				rules: [],
				timers: [],
				typeId: "infraction",
				key: "rule_ref",
				now: MAR,
				field: citing(),
				agreements: [],
			}),
		).toEqual([]);
	});
});
