import { describe, expect, it } from "vitest";
import { hashPin, pinMatches } from "./pin.ts";

/**
 * The PIN lock is a discretion feature (handoff §3.5, #42), not a cryptographic
 * boundary against someone who already controls the device — it keeps a casual
 * over-the-shoulder glance out. The stored value is only ever a hash of the PIN;
 * the plaintext PIN is never persisted.
 */

describe("hashPin", () => {
	it("is deterministic for the same PIN", async () => {
		expect(await hashPin("1234")).toBe(await hashPin("1234"));
	});

	it("differs for different PINs and never returns the plaintext", async () => {
		const h = await hashPin("1234");
		expect(h).not.toBe(await hashPin("4321"));
		expect(h).not.toContain("1234");
	});
});

describe("pinMatches", () => {
	it("accepts the PIN that produced the stored hash", async () => {
		const stored = await hashPin("2468");
		expect(await pinMatches(stored, "2468")).toBe(true);
	});

	it("rejects a wrong PIN", async () => {
		const stored = await hashPin("2468");
		expect(await pinMatches(stored, "0000")).toBe(false);
	});

	it("rejects any PIN when none is set (null store)", async () => {
		expect(await pinMatches(null, "2468")).toBe(false);
	});
});
