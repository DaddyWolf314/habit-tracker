import { describe, expect, it } from "vitest";
import { STARTER_EVENT_TYPES } from "#/templates/index.ts";
import type { EventType } from "./event-types.ts";
import {
	isOriginatingRef,
	mintOriginatingRefs,
	readableMetadata,
} from "./refs.ts";

/**
 * The originating side of the ref model (ADR 0005). The DO calls
 * `mintOriginatingRefs` before persisting, so these cover what it guarantees:
 * every minted key gets a fresh id, a client-supplied one is refused, and the
 * ids the log already holds are never touched.
 */

const byId = new Map(STARTER_EVENT_TYPES.map((t) => [t.id, t]));
const typeOf = (id: string): EventType => {
	const type = byId.get(id);
	if (!type) throw new Error(`no starter type ${id}`);
	return type;
};

/** A mint that is distinguishable per call, standing in for `ulid()`. */
function counterMint() {
	let n = 0;
	return () => `id-${++n}`;
}

describe("which fields the pack marks as originating (ADR 0005)", () => {
	it("is exactly the three events that name an id for the first time", () => {
		const originating = STARTER_EVENT_TYPES.flatMap((t) =>
			Object.entries(t.metadata)
				.filter(([, f]) => isOriginatingRef(f))
				.map(([key]) => `${t.id}.${key}`),
		);
		expect(originating.sort()).toEqual([
			"journal_prompt.prompt_id",
			"session_started.session_id",
			"task_assigned.task_id",
		]);
	});

	it("leaves the echoing side alone — a close still supplies its own ref", () => {
		for (const [id, key] of [
			["task_completed", "task_id"],
			["session_ended", "session_id"],
			["journal_entry", "prompt_id"],
		] as const) {
			const field = typeOf(id).metadata[key];
			if (!field) throw new Error(`no ${id}.${key}`);
			expect(isOriginatingRef(field)).toBe(false);
		}
	});
});

describe("minting at log time", () => {
	it("assigns a task_id the client never sent, and leaves the rest untouched", () => {
		const result = mintOriginatingRefs(
			typeOf("task_assigned"),
			{ task_name: "dishes", duration_ms: 60_000 },
			counterMint(),
		);
		expect(result).toEqual({
			ok: true,
			metadata: { task_id: "id-1", task_name: "dishes", duration_ms: 60_000 },
		});
	});

	it("assigns a session_id, so `session_started` needs no hand-typed ref", () => {
		// The worst instance of the problem #89 set out to fix: a required free-text
		// ref that can have no candidates, because the event *is* the origin.
		const result = mintOriginatingRefs(
			typeOf("session_started"),
			{ activity: "service" },
			counterMint(),
		);
		expect(result).toEqual({
			ok: true,
			metadata: { session_id: "id-1", activity: "service" },
		});
	});

	it("mints a distinct id per event, so two same-named tasks never collide", () => {
		const mint = counterMint();
		const first = mintOriginatingRefs(
			typeOf("task_assigned"),
			{ task_name: "dishes", duration_ms: 60_000 },
			mint,
		);
		const second = mintOriginatingRefs(
			typeOf("task_assigned"),
			{ task_name: "dishes", duration_ms: 60_000 },
			mint,
		);
		if (!first.ok || !second.ok) throw new Error("unreachable");
		expect(first.metadata.task_id).not.toBe(second.metadata.task_id);
	});

	it("rejects a client-supplied value on each minted field", () => {
		for (const [id, key] of [
			["task_assigned", "task_id"],
			["session_started", "session_id"],
			["journal_prompt", "prompt_id"],
		] as const) {
			const result = mintOriginatingRefs(
				typeOf(id),
				{ [key]: "mine" },
				counterMint(),
			);
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.error).toContain(key);
		}
	});

	it("does not mutate the caller's metadata (a replay reads the stored id)", () => {
		// Minting precedes persistence, so a rebuild replays what was stored rather
		// than minting again; the input object staying clean is the small version of
		// that same discipline.
		const input = { task_name: "dishes", duration_ms: 60_000 };
		mintOriginatingRefs(typeOf("task_assigned"), input, counterMint());
		expect(input).toEqual({ task_name: "dishes", duration_ms: 60_000 });
	});

	it("mints nothing on a type with no originating ref", () => {
		const result = mintOriginatingRefs(
			typeOf("task_completed"),
			{ task_id: "id-1" },
			counterMint(),
		);
		expect(result).toEqual({ ok: true, metadata: { task_id: "id-1" } });
	});
});

describe("what a human-facing surface shows", () => {
	it("hides the minted ref and keeps everything else", () => {
		expect(
			readableMetadata(typeOf("journal_prompt"), {
				prompt_id: "01JB6X",
				floor: "sealed",
			}),
		).toEqual([["floor", "sealed"]]);
	});

	it("keeps an echoing ref — it is the id the author actually chose", () => {
		expect(
			readableMetadata(typeOf("task_completed"), {
				task_id: "01JB6X",
				quality: "met",
			}),
		).toEqual([
			["task_id", "01JB6X"],
			["quality", "met"],
		]);
	});

	it("hides nothing for an unknown type or an unknown key", () => {
		expect(readableMetadata(undefined, { prompt_id: "01JB6X" })).toEqual([
			["prompt_id", "01JB6X"],
		]);
		expect(
			readableMetadata(typeOf("journal_prompt"), { wombat: "yes" }),
		).toEqual([["wombat", "yes"]]);
	});
});
