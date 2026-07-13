import { describe, expect, it } from "vitest";
import {
	canFinalize,
	RECOVERY_WAIT_MS,
	type RecoveryState,
	recoveryView,
} from "./recovery.ts";

/**
 * Partner-assisted recovery (handoff §2): a lost-token member's slot is rebound
 * to a fresh identity, but only after the partner starts it AND a mandatory
 * waiting period elapses — the window in which the old identity's remaining
 * devices can interrupt a stolen-phone takeover. These pure helpers own the
 * timing gate; the DO owns the credential lifecycle around them.
 */

const base: RecoveryState = {
	member_id: "member-lost",
	started_by: "member-partner",
	old_identity_hash: "old-hash",
	rebind_at: 1_000 + RECOVERY_WAIT_MS,
	status: "pending",
	new_identity_hash: null,
	new_credential_hash: null,
};

describe("RECOVERY_WAIT_MS", () => {
	it("is the chosen 24-hour friction window", () => {
		expect(RECOVERY_WAIT_MS).toBe(24 * 60 * 60 * 1000);
	});
});

describe("canFinalize", () => {
	const redeemed: RecoveryState = {
		...base,
		status: "redeemed",
		new_identity_hash: "new-hash",
		new_credential_hash: "new-cred",
	};

	it("is false before the waiting period elapses, even once redeemed", () => {
		expect(canFinalize(redeemed, redeemed.rebind_at - 1)).toBe(false);
	});

	it("is true once redeemed and the waiting period has elapsed", () => {
		expect(canFinalize(redeemed, redeemed.rebind_at)).toBe(true);
	});

	it("is false while still awaiting redemption, no matter how much time passed", () => {
		expect(canFinalize(base, base.rebind_at + 1_000_000)).toBe(false);
	});

	it("is false once cancelled", () => {
		expect(
			canFinalize({ ...redeemed, status: "cancelled" }, redeemed.rebind_at),
		).toBe(false);
	});
});

describe("recoveryView", () => {
	it("reports the remaining wait and that finalize is not yet allowed", () => {
		const view = recoveryView({ ...base, status: "redeemed" }, 1_000);
		expect(view.redeemed).toBe(true);
		expect(view.wait_remaining_ms).toBe(RECOVERY_WAIT_MS);
		expect(view.finalizable).toBe(false);
	});

	it("clamps the remaining wait to zero and allows finalize once elapsed", () => {
		const view = recoveryView(
			{ ...base, status: "redeemed" },
			base.rebind_at + 5,
		);
		expect(view.wait_remaining_ms).toBe(0);
		expect(view.finalizable).toBe(true);
	});

	it("never allows finalize while only pending (not yet redeemed)", () => {
		const view = recoveryView(base, base.rebind_at + 5);
		expect(view.redeemed).toBe(false);
		expect(view.finalizable).toBe(false);
	});
});
