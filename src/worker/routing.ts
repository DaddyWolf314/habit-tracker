import type { CoupleDO } from "./do/couple-do.ts";

/**
 * Resolves a couple id to its Durable Object stub. Phase 0 keys the DO by a
 * caller-supplied couple id; Phase 1 derives that id from the bearer credential
 * via the D1 routing table, so a client can never address another couple's DO.
 */
export function coupleStub(
	env: Env,
	coupleId: string,
): DurableObjectStub<CoupleDO> {
	return env.COUPLE_DO.getByName(coupleId);
}
