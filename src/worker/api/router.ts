import { eq } from "drizzle-orm";
import { getRoutingDb } from "#/db/index.ts";
import { credentials } from "#/db/schema.ts";
import { sha256Base64url } from "#/lib/crypto.ts";
import { authenticate, bearerToken, credentialHashOf } from "../auth.ts";
import { statusFromError } from "../do/errors.ts";
import { coupleStubById } from "../routing.ts";
import { errorResponse, json } from "./http.ts";

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
			return await getSession(request, env);
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

/** GET /api/session — whoami for the authenticated caller. */
async function getSession(request: Request, env: Env): Promise<Response> {
	const auth = await authenticate(request, env);
	if (!auth) return errorResponse("unauthorized", 401);
	const stub = coupleStubById(env, auth.coupleDoId);
	const state = await stub.getState(auth.identityHash);
	return json(state);
}
