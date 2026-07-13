import { z } from "zod";

/**
 * Partner-assisted recovery (handoff §2). A member who lost their token creates
 * a fresh identity and, with the remaining partner's help, rebinds their member
 * slot to it — old credential revoked. The friction that makes a stolen phone an
 * *interruptible* event is partner approval PLUS a mandatory waiting period, the
 * window in which the old identity's remaining devices can cancel. If both
 * tokens are lost the data is unrecoverable, by design.
 *
 * This module owns the timing gate as pure, unit-testable logic; the DO owns the
 * credential lifecycle (mint code → redeem → cancel/finalize) around it.
 */

/** The mandatory waiting period before a slot may rebind — the user chose 24h. */
export const RECOVERY_WAIT_MS = 24 * 60 * 60 * 1000;

export const recoveryStatusSchema = z.enum([
	"pending", // partner started it; awaiting the fresh identity's redemption
	"redeemed", // fresh identity bound; waiting out the window
	"cancelled", // interrupted by the old identity (or partner)
	"completed", // slot rebound, old credential revoked
]);
export type RecoveryStatus = z.infer<typeof recoveryStatusSchema>;

/** The DO's active recovery (at most one at a time). */
export interface RecoveryState {
	/** The slot being recovered — the lost-token member. */
	member_id: string;
	/** The partner who started the recovery (must be the other member). */
	started_by: string;
	/** The lost identity being replaced; captured so finalize can revoke it. */
	old_identity_hash: string;
	/** When the slot may rebind: the start time plus the waiting period. */
	rebind_at: number;
	status: RecoveryStatus;
	/** The fresh identity taking over the slot; null until redeemed. */
	new_identity_hash: string | null;
	/** The fresh identity's routing credential; null until redeemed. */
	new_credential_hash: string | null;
}

/** A member-facing view for polling and the old-device interrupt prompt. */
export interface RecoveryView {
	member_id: string;
	status: RecoveryStatus;
	rebind_at: number;
	/** Whether the fresh identity has redeemed the code yet. */
	redeemed: boolean;
	/** ms until the slot may rebind; 0 once the window has elapsed. */
	wait_remaining_ms: number;
	/** True once redeemed AND the window has elapsed — finalize may proceed. */
	finalizable: boolean;
}

/**
 * Whether the slot may now rebind to the new identity: it must have been redeemed
 * (a fresh identity is bound) and the waiting period must have fully elapsed. A
 * `pending` (un-redeemed) or `cancelled` recovery never finalizes, no matter how
 * much time has passed.
 */
export function canFinalize(state: RecoveryState, now: number): boolean {
	return state.status === "redeemed" && now >= state.rebind_at;
}

/** Projects the recovery for a member: remaining wait and whether it can finalize. */
export function recoveryView(state: RecoveryState, now: number): RecoveryView {
	return {
		member_id: state.member_id,
		status: state.status,
		rebind_at: state.rebind_at,
		redeemed: state.status === "redeemed" || state.status === "completed",
		wait_remaining_ms: Math.max(0, state.rebind_at - now),
		finalizable: canFinalize(state, now),
	};
}
