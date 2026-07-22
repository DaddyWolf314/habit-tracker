import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getRoutingDb } from "#/db/index.ts";
import { credentials, invites, recoveries } from "#/db/schema.ts";
import { randomToken, sha256Base64url } from "#/lib/crypto.ts";
import {
	adjustCounterInputSchema,
	createCounterInputSchema,
	resetCounterInputSchema,
} from "#/shared/counters.ts";
import { logEventInputSchema } from "#/shared/events.ts";
import {
	mintDeviceInputSchema,
	proposeRolesInputSchema,
	redeemInviteInputSchema,
	revokeDeviceInputSchema,
} from "#/shared/identity.ts";
import { introspectInputSchema } from "#/shared/introspection.ts";
import {
	type AuthContext,
	authenticate,
	bearerToken,
	credentialHashOf,
} from "../auth.ts";
import type { CoupleDO } from "../do/couple-do.ts";
import { statusFromError } from "../do/errors.ts";
import { coupleStubById } from "../routing.ts";
import { errorResponse, json, readJson } from "./http.ts";

/** An authenticated request, with the couple DO stub resolved. */
interface AuthedRequest {
	auth: AuthContext;
	stub: DurableObjectStub<CoupleDO>;
}

/** A non-empty identifier (counter id, event id) from a request body/query. */
const idSchema = z.string().min(1);

/**
 * Worker-native JSON API for identity, devices, pairing, roles, and the
 * dissolve/export escape hatches. Dispatched from the server entry for `/api/*`
 * (except `/api/ws`). Every relationship mutation is proxied to the couple's
 * Durable Object, which is the serialized source of truth.
 */
export async function handleApi(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;

	try {
		if (path === "/api/identity" && method === "POST") {
			return await createIdentity(request, env);
		}
		if (path === "/api/session" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub.getState(auth.identityHash).then((s) => json(s)),
			);
		}
		if (path === "/api/devices" && method === "POST") {
			return await withAuth(request, env, (ctx) =>
				mintDevice(request, env, ctx),
			);
		}
		if (path === "/api/devices" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub
					.listDevices(auth.identityHash, auth.credentialHash)
					.then((devices) => json({ devices })),
			);
		}
		if (path === "/api/devices/revoke" && method === "POST") {
			return await withAuth(request, env, (ctx) =>
				revokeDevice(request, env, ctx),
			);
		}
		if (path === "/api/invites" && method === "POST") {
			return await withAuth(request, env, (ctx) => createInvite(env, ctx));
		}
		if (path === "/api/invites/redeem" && method === "POST") {
			return await redeemInvite(request, env);
		}
		if (path === "/api/roles" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub.getRoleState(auth.identityHash).then((s) => json(s)),
			);
		}
		if (path === "/api/roles/propose" && method === "POST") {
			return await withAuth(request, env, (ctx) => proposeRoles(request, ctx));
		}
		if (path === "/api/roles/confirm" && method === "POST") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub.confirmRoles(auth.identityHash).then((s) => json(s)),
			);
		}
		if (path === "/api/consent-history" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub
					.listConsentHistory(auth.identityHash)
					.then((entries) => json({ entries })),
			);
		}
		if (path === "/api/dissolve" && method === "POST") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub.dissolve(auth.identityHash).then((r) => json(r)),
			);
		}
		if (path === "/api/pause" && method === "POST") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub.pause(auth.identityHash).then((r) => json(r)),
			);
		}
		if (path === "/api/resume" && method === "POST") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub.resume(auth.identityHash).then((r) => json(r)),
			);
		}
		if (path === "/api/recovery/start" && method === "POST") {
			return await withAuth(request, env, (ctx) => startRecovery(env, ctx));
		}
		if (path === "/api/recovery/redeem" && method === "POST") {
			return await redeemRecovery(request, env);
		}
		if (path === "/api/recovery/cancel" && method === "POST") {
			return await withAuth(request, env, (ctx) => cancelRecovery(env, ctx));
		}
		if (path === "/api/recovery/finalize" && method === "POST") {
			return await withAuth(request, env, (ctx) => finalizeRecovery(env, ctx));
		}
		if (path === "/api/recovery" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub
					.getRecovery(auth.identityHash)
					.then((recovery) => json({ recovery })),
			);
		}
		if (path === "/api/notifications" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub.notificationCount(auth.identityHash).then((r) => json(r)),
			);
		}
		if (path === "/api/export" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub.exportData(auth.identityHash).then((data) =>
					json(data, 200, {
						"content-disposition":
							'attachment; filename="strawberry-export.json"',
					}),
				),
			);
		}
		if (path === "/api/couple" && method === "DELETE") {
			return await withAuth(request, env, (ctx) => deleteCouple(env, ctx));
		}
		if (path === "/api/support/introspect" && method === "POST") {
			return await withAuth(request, env, async ({ auth, stub }) => {
				const parsed = await readJson(request, introspectInputSchema);
				if ("response" in parsed) return parsed.response;
				const result = await stub.introspect(
					auth.identityHash,
					parsed.data.projection,
				);
				return json(result);
			});
		}
		if (path === "/api/support/audit" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub
					.listAuditLog(auth.identityHash)
					.then((entries) => json({ entries })),
			);
		}

		// ── Phase 2: event log + counters ──────────────────────────────────────
		if (path === "/api/event-types" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub.listEventTypes(auth.identityHash).then((types) => json({ types })),
			);
		}
		if (path === "/api/event-types" && method === "POST") {
			return await withAuth(request, env, async ({ auth, stub }) => {
				const body = await request.json().catch(() => null);
				const type = await stub.createEventType(auth.identityHash, body);
				return json(type, 201);
			});
		}
		if (path === "/api/events" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub.listEvents(auth.identityHash).then((events) => json({ events })),
			);
		}
		if (path === "/api/events" && method === "POST") {
			return await withAuth(request, env, async ({ auth, stub }) => {
				const parsed = await readJson(request, logEventInputSchema);
				if ("response" in parsed) return parsed.response;
				const event = await stub.logEvent(auth.identityHash, parsed.data);
				return json(event, 201);
			});
		}
		if (path === "/api/events/amend" && method === "POST") {
			return await withAuth(request, env, async ({ auth, stub }) => {
				const body = await request.json().catch(() => null);
				const event = await stub.amend(auth.identityHash, body);
				return json(event, 201);
			});
		}
		if (path === "/api/events/trace" && method === "GET") {
			const eventId = url.searchParams.get("event_id") ?? "";
			return await withAuth(request, env, ({ auth, stub }) =>
				stub
					.getEventTrace(auth.identityHash, eventId)
					.then((rows) => json({ rows })),
			);
		}
		if (path === "/api/counters" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub
					.listCounters(auth.identityHash)
					.then((counters) => json({ counters })),
			);
		}
		if (path === "/api/counters" && method === "POST") {
			return await withAuth(request, env, async ({ auth, stub }) => {
				const parsed = await readJson(request, createCounterInputSchema);
				if ("response" in parsed) return parsed.response;
				// The DO derives the id from the name and disambiguates collisions.
				const counter = await stub.createCounter(
					auth.identityHash,
					parsed.data,
				);
				return json(counter, 201);
			});
		}
		if (path === "/api/counters/adjust" && method === "POST") {
			return await withAuth(request, env, async ({ auth, stub }) => {
				const parsed = await readJson(
					request,
					adjustCounterInputSchema.extend({ counter_id: idSchema }),
				);
				if ("response" in parsed) return parsed.response;
				const counter = await stub.adjustCounter(
					auth.identityHash,
					parsed.data.counter_id,
					parsed.data.delta,
					parsed.data.note,
				);
				return json(counter);
			});
		}
		if (path === "/api/counters/reset" && method === "POST") {
			return await withAuth(request, env, async ({ auth, stub }) => {
				const parsed = await readJson(
					request,
					resetCounterInputSchema.extend({ counter_id: idSchema }),
				);
				if ("response" in parsed) return parsed.response;
				const counter = await stub.resetCounter(
					auth.identityHash,
					parsed.data.counter_id,
					parsed.data.note,
				);
				return json(counter);
			});
		}
		if (path === "/api/counters/rebuild" && method === "POST") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub
					.rebuildCounters(auth.identityHash)
					.then((counters) => json({ counters })),
			);
		}
		if (path === "/api/counters/trace" && method === "GET") {
			const counterId = url.searchParams.get("counter_id") ?? "";
			return await withAuth(request, env, ({ auth, stub }) =>
				stub
					.getCounterTrace(auth.identityHash, counterId)
					.then((trace) => json(trace)),
			);
		}

		// ── Phase 3: rules engine ──────────────────────────────────────────────
		if (path === "/api/rules" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub.listRules(auth.identityHash).then((rules) => json({ rules })),
			);
		}
		if (path === "/api/rules" && method === "POST") {
			return await withAuth(request, env, async ({ auth, stub }) => {
				const body = await request.json().catch(() => null);
				const rule = await stub.createRule(auth.identityHash, body);
				return json(rule, 201);
			});
		}
		// ── #64: rules screen — view, edit, enable/disable, delete ──────────────
		if (path === "/api/rules/history" && method === "GET") {
			return await withAuth(request, env, ({ auth, stub }) =>
				stub
					.listRuleHistory(auth.identityHash)
					.then((rules) => json({ rules })),
			);
		}
		const ruleMatch = path.match(/^\/api\/rules\/([^/]+)$/);
		if (ruleMatch) {
			const id = decodeURIComponent(ruleMatch[1]);
			if (method === "PUT") {
				return await withAuth(request, env, async ({ auth, stub }) => {
					const body = await request.json().catch(() => null);
					const rule = await stub.updateRule(auth.identityHash, id, body);
					return json(rule);
				});
			}
			if (method === "DELETE") {
				return await withAuth(request, env, ({ auth, stub }) =>
					stub.deleteRule(auth.identityHash, id).then((r) => json(r)),
				);
			}
		}
		const ruleEnabledMatch = path.match(/^\/api\/rules\/([^/]+)\/enabled$/);
		if (ruleEnabledMatch && method === "PUT") {
			const id = decodeURIComponent(ruleEnabledMatch[1]);
			return await withAuth(request, env, async ({ auth, stub }) => {
				const body = (await request.json().catch(() => null)) as {
					enabled?: unknown;
				} | null;
				const rule = await stub.setRuleEnabled(
					auth.identityHash,
					id,
					body?.enabled === true,
				);
				return json(rule);
			});
		}
		return errorResponse("not found", 404);
	} catch (error) {
		const { status, message } = statusFromError(error);
		if (status === 500) console.error("API error", error);
		return errorResponse(message, status);
	}
}

/**
 * Derives the stable identity anchor from a root secret. Kept distinct from the
 * credential hash (which auth computes as `sha256(token)`) so "who you are" and
 * "the key you presented" are separate values.
 */
export function deriveIdentityHash(secret: string): Promise<string> {
	return sha256Base64url(`strawberry:identity:${secret}`);
}

/**
 * POST /api/identity — Partner A. The bearer is the client-generated root
 * secret; we store only its hash, mint a fresh couple DO, and bind A as the
 * founding member. Idempotency: a secret that already maps to a couple is a
 * conflict, not a second couple.
 */
async function createIdentity(request: Request, env: Env): Promise<Response> {
	const secret = bearerToken(request);
	if (!secret) return errorResponse("missing bearer credential", 401);

	const credentialHash = await credentialHashOf(secret);
	const db = getRoutingDb(env.DB);

	const existing = await db
		.select({ id: credentials.credentialHash })
		.from(credentials)
		.where(eq(credentials.credentialHash, credentialHash))
		.get();
	if (existing) return errorResponse("identity already exists", 409);

	const identityHash = await deriveIdentityHash(secret);
	const id = env.COUPLE_DO.newUniqueId();
	const stub = env.COUPLE_DO.get(id);
	const { member_id } = await stub.createCouple(identityHash);

	await db.insert(credentials).values({
		credentialHash,
		identityHash,
		coupleDoId: id.toString(),
		kind: "root",
		label: "recovery phrase",
	});

	return json({ couple_do_id: id.toString(), member_id }, 201);
}

/** Authenticates a request and runs `handler` with the resolved DO stub. */
async function withAuth(
	request: Request,
	env: Env,
	handler: (ctx: AuthedRequest) => Promise<Response>,
): Promise<Response> {
	const auth = await authenticate(request, env);
	if (!auth) return errorResponse("unauthorized", 401);
	return handler({ auth, stub: coupleStubById(env, auth.coupleDoId) });
}

/**
 * POST /api/devices — mint a new device token for day-to-day auth (handoff §2).
 * The raw token is returned exactly once; only its hash is stored, both in the
 * DO's device list and as a routing-layer credential.
 */
async function mintDevice(
	request: Request,
	env: Env,
	{ auth, stub }: AuthedRequest,
): Promise<Response> {
	const parsed = await readJson(request, mintDeviceInputSchema);
	if ("response" in parsed) return parsed.response;

	const token = randomToken();
	const tokenHash = await credentialHashOf(token);
	const label = parsed.data.label ?? null;
	const device = await stub.addDevice(auth.identityHash, tokenHash, label);

	await getRoutingDb(env.DB).insert(credentials).values({
		credentialHash: tokenHash,
		identityHash: auth.identityHash,
		coupleDoId: auth.coupleDoId,
		kind: "device",
		label,
	});

	return json({ token, device }, 201);
}

/**
 * POST /api/devices/revoke — revoke a device. The DO returns the token hash and
 * we flip the routing credential to revoked, so the token stops authenticating.
 */
async function revokeDevice(
	request: Request,
	env: Env,
	{ auth, stub }: AuthedRequest,
): Promise<Response> {
	const parsed = await readJson(request, revokeDeviceInputSchema);
	if ("response" in parsed) return parsed.response;

	const { token_hash } = await stub.revokeDevice(
		auth.identityHash,
		parsed.data.device_id,
	);
	await getRoutingDb(env.DB)
		.update(credentials)
		.set({ revokedAt: new Date() })
		.where(eq(credentials.credentialHash, token_hash));

	return json({ ok: true });
}

/** How long a pairing invite stays valid. */
const INVITE_TTL_MS = 15 * 60 * 1000;

/**
 * POST /api/invites — Partner A mints a short-lived, single-use invite. Only
 * valid while the couple is still pairing and alone; supersedes any prior unused
 * invite so at most one is live at a time (basic rate-limit).
 */
async function createInvite(
	env: Env,
	{ auth, stub }: AuthedRequest,
): Promise<Response> {
	const state = await stub.getState(auth.identityHash);
	if (state.invitations_closed || state.member_count >= 2) {
		return errorResponse("this couple is already paired", 409);
	}

	const code = randomToken();
	const codeHash = await sha256Base64url(code);
	const db = getRoutingDb(env.DB);
	// One live invite per couple: drop prior unused ones.
	await db
		.delete(invites)
		.where(
			and(eq(invites.coupleDoId, auth.coupleDoId), isNull(invites.usedAt)),
		);
	const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
	await db.insert(invites).values({
		codeHash,
		coupleDoId: auth.coupleDoId,
		expiresAt,
	});

	return json({ code, expires_at: expiresAt.getTime() }, 201);
}

/**
 * POST /api/invites/redeem — Partner B. Authenticates with a brand-new secret
 * (no routing row yet, so this is unauthenticated in the usual sense), binds B
 * into A's couple, and marks the invite used. The DO enforces that the couple
 * can never exceed two members.
 */
async function redeemInvite(request: Request, env: Env): Promise<Response> {
	const secret = bearerToken(request);
	if (!secret) return errorResponse("missing bearer credential", 401);
	const parsed = await readJson(request, redeemInviteInputSchema);
	if ("response" in parsed) return parsed.response;

	const db = getRoutingDb(env.DB);
	const codeHash = await sha256Base64url(parsed.data.code);
	const invite = await db
		.select()
		.from(invites)
		.where(eq(invites.codeHash, codeHash))
		.get();
	if (!invite) return errorResponse("invalid invite code", 404);
	if (invite.usedAt) return errorResponse("invite already used", 410);
	if (invite.expiresAt.getTime() < Date.now())
		return errorResponse("invite expired", 410);

	const credentialHash = await credentialHashOf(secret);
	const existing = await db
		.select({ id: credentials.credentialHash })
		.from(credentials)
		.where(eq(credentials.credentialHash, credentialHash))
		.get();
	if (existing) return errorResponse("identity already exists", 409);

	const identityHash = await deriveIdentityHash(secret);
	const stub = coupleStubById(env, invite.coupleDoId);
	const { member_id } = await stub.joinCouple(identityHash);

	await db.insert(credentials).values({
		credentialHash,
		identityHash,
		coupleDoId: invite.coupleDoId,
		kind: "root",
		label: "recovery phrase",
	});
	await db
		.update(invites)
		.set({ usedAt: new Date() })
		.where(eq(invites.codeHash, codeHash));

	return json({ couple_do_id: invite.coupleDoId, member_id }, 201);
}

/** POST /api/roles/propose — propose a role assignment covering both members. */
async function proposeRoles(
	request: Request,
	{ auth, stub }: AuthedRequest,
): Promise<Response> {
	const parsed = await readJson(request, proposeRolesInputSchema);
	if ("response" in parsed) return parsed.response;
	const state = await stub.proposeRoles(
		auth.identityHash,
		parsed.data.assignment,
	);
	return json(state);
}

/**
 * DELETE /api/couple — the real teardown (handoff §3.5). The DO must already be
 * dissolved (the freeze-and-export-offer gate); the DO wipes its own storage,
 * then we purge every routing row that points at it — the two members' root
 * credentials, any device credentials, any live invite, and any in-flight
 * recovery code — so no bearer can ever resolve to this couple again. "Delete
 * your account and the database containing your relationship's data ceases to
 * exist" becomes literally true.
 */
async function deleteCouple(
	env: Env,
	{ auth, stub }: AuthedRequest,
): Promise<Response> {
	await stub.purge(auth.identityHash);
	const db = getRoutingDb(env.DB);
	await db
		.delete(credentials)
		.where(eq(credentials.coupleDoId, auth.coupleDoId));
	await db.delete(invites).where(eq(invites.coupleDoId, auth.coupleDoId));
	// A recovery in flight at dissolve time leaves a routing row keyed to this
	// couple (member id + dead DO id) — residual, identifying data. Purge it too,
	// or "the database ceases to exist" would be a lie for a couple mid-recovery.
	await db.delete(recoveries).where(eq(recoveries.coupleDoId, auth.coupleDoId));
	return json({ ok: true });
}

/** How long a recovery code stays redeemable — the interrupt window (#41). */
const RECOVERY_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * POST /api/recovery/start — the remaining partner begins recovery of the lost
 * member's slot (#41). The DO sets the waiting window; we mint a single-use code
 * (superseding any prior live one) that the lost-token user redeems with a fresh
 * identity. The code is a brief bearer credential, like a pairing invite.
 */
async function startRecovery(
	env: Env,
	{ auth, stub }: AuthedRequest,
): Promise<Response> {
	const { member_id, rebind_at } = await stub.startRecovery(auth.identityHash);
	const code = randomToken();
	const codeHash = await sha256Base64url(code);
	const db = getRoutingDb(env.DB);
	await db
		.delete(recoveries)
		.where(
			and(
				eq(recoveries.coupleDoId, auth.coupleDoId),
				isNull(recoveries.usedAt),
			),
		);
	const expiresAt = new Date(Date.now() + RECOVERY_CODE_TTL_MS);
	await db.insert(recoveries).values({
		codeHash,
		coupleDoId: auth.coupleDoId,
		memberId: member_id,
		expiresAt,
	});
	return json({ code, member_id, rebind_at, expires_at: expiresAt.getTime() });
}

/**
 * POST /api/recovery/redeem — the lost-token user binds a brand-new secret to the
 * pending recovery (#41). Like invite redemption this is unauthenticated in the
 * usual sense: the fresh secret has no routing row yet. We create its routing
 * credential now so it can poll and later finalize, but it is not a member until
 * the slot rebinds — the DO's `requireMember` still refuses it in the meantime.
 */
async function redeemRecovery(request: Request, env: Env): Promise<Response> {
	const secret = bearerToken(request);
	if (!secret) return errorResponse("missing bearer credential", 401);
	const parsed = await readJson(request, redeemInviteInputSchema);
	if ("response" in parsed) return parsed.response;

	const db = getRoutingDb(env.DB);
	const codeHash = await sha256Base64url(parsed.data.code);
	const recovery = await db
		.select()
		.from(recoveries)
		.where(eq(recoveries.codeHash, codeHash))
		.get();
	if (!recovery) return errorResponse("invalid recovery code", 404);
	if (recovery.usedAt) return errorResponse("recovery code already used", 410);
	if (recovery.expiresAt.getTime() < Date.now())
		return errorResponse("recovery code expired", 410);

	const credentialHash = await credentialHashOf(secret);
	const existing = await db
		.select({ id: credentials.credentialHash })
		.from(credentials)
		.where(eq(credentials.credentialHash, credentialHash))
		.get();
	if (existing) return errorResponse("identity already exists", 409);

	const identityHash = await deriveIdentityHash(secret);
	const stub = coupleStubById(env, recovery.coupleDoId);
	const { member_id, rebind_at } = await stub.redeemRecovery(
		identityHash,
		credentialHash,
	);

	await db.insert(credentials).values({
		credentialHash,
		identityHash,
		coupleDoId: recovery.coupleDoId,
		kind: "root",
		label: "recovery phrase",
	});
	await db
		.update(recoveries)
		.set({ usedAt: new Date() })
		.where(eq(recoveries.codeHash, codeHash));

	return json({ couple_do_id: recovery.coupleDoId, member_id, rebind_at });
}

/**
 * POST /api/recovery/cancel — interrupt a recovery (#41), the stolen-phone escape
 * valve. Either member may cancel; the DO clears the recovery and hands back the
 * fresh identity's credential so we revoke its routing row.
 */
async function cancelRecovery(
	env: Env,
	{ auth, stub }: AuthedRequest,
): Promise<Response> {
	const { new_credential_hash } = await stub.cancelRecovery(auth.identityHash);
	if (new_credential_hash) {
		await getRoutingDb(env.DB)
			.delete(credentials)
			.where(eq(credentials.credentialHash, new_credential_hash));
	}
	return json({ ok: true });
}

/**
 * POST /api/recovery/finalize — once the window has elapsed, the fresh identity
 * completes the rebind (#41). The DO swaps the member slot to the new identity;
 * we then revoke every routing credential the old identity held for this couple,
 * so the lost/stolen tokens stop authenticating.
 */
async function finalizeRecovery(
	env: Env,
	{ auth, stub }: AuthedRequest,
): Promise<Response> {
	const { old_identity_hash } = await stub.finalizeRecovery(auth.identityHash);
	await getRoutingDb(env.DB)
		.update(credentials)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(credentials.identityHash, old_identity_hash),
				eq(credentials.coupleDoId, auth.coupleDoId),
			),
		);
	return json({ ok: true });
}
