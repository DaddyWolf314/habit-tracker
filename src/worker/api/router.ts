import { eq } from "drizzle-orm";
import { getRoutingDb } from "#/db/index.ts";
import { credentials } from "#/db/schema.ts";
import { randomToken, sha256Base64url } from "#/lib/crypto.ts";
import {
	mintDeviceInputSchema,
	revokeDeviceInputSchema,
} from "#/shared/identity.ts";
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
