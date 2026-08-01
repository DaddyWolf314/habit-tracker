/**
 * A stand-in for `cloudflare:workers`, aliased in by `vitest.config.ts` so the
 * DO's module graph resolves under plain Node.
 *
 * `couple-do.ts` imports exactly one thing from the real module — the
 * `DurableObject` base class — and uses exactly two things from it: the `ctx`
 * and `env` that `super(ctx, env)` assigns. Everything else `CoupleDO` touches
 * comes off the `DurableObjectState` the test hands to the constructor, so this
 * is the whole of the runtime surface the base class contributes.
 *
 * Deliberately not a general workerd shim. If a future import from
 * `cloudflare:workers` needs more than this, add it here with the same
 * narrowness — a fake that grows past what the code under test calls stops
 * being checkable against the real thing.
 */
export class DurableObject<E = unknown> {
	readonly ctx: DurableObjectState;
	readonly env: E;

	constructor(ctx: DurableObjectState, env: E) {
		this.ctx = ctx;
		this.env = env;
	}
}
