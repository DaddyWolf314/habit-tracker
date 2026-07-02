import type { CoupleDO } from "./do/couple-do.ts";

/**
 * Resolves a couple's Durable Object stub from the hex id stored in the routing
 * table. This is the authenticated path: the id comes from the caller's bearer
 * credential (never from client input), so a client can only ever reach its own
 * couple's DO.
 */
export function coupleStubById(
	env: Env,
	coupleDoId: string,
): DurableObjectStub<CoupleDO> {
	const id = env.COUPLE_DO.idFromString(coupleDoId);
	return env.COUPLE_DO.get(id);
}

/**
 * Name-keyed stub. Used only by the Phase 0 WebSocket dev path, which addresses
 * a DO by a caller-supplied couple name before real auth exists.
 */
export function coupleStub(
	env: Env,
	coupleId: string,
): DurableObjectStub<CoupleDO> {
	return env.COUPLE_DO.getByName(coupleId);
}
