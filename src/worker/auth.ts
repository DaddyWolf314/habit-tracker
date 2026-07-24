import { and, eq, isNull } from "drizzle-orm";
import { getRoutingDb } from "#/db/index.ts";
import { credentials } from "#/db/schema.ts";
import { sha256Base64url } from "#/lib/crypto.ts";
import { coupleStubById } from "./routing.ts";

/**
 * An authenticated caller, resolved from a bearer credential via the D1 routing
 * table. Holds only what routing knows — identity, couple DO, credential kind —
 * never any relationship data (that lives in the DO).
 */
export interface AuthContext {
	identityHash: string;
	coupleDoId: string;
	credentialHash: string;
	kind: "root" | "device";
}

/** Extracts the bearer token from an `Authorization: Bearer <token>` header. */
export function bearerToken(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match ? match[1].trim() : null;
}

/** Hashes a bearer token into the value stored as `credential_hash`. */
export function credentialHashOf(token: string): Promise<string> {
	return sha256Base64url(token);
}

/**
 * Resolves the request's bearer credential to an {@link AuthContext}, or null if
 * absent, unknown, or revoked. Membership and role are looked up inside the DO;
 * this only proves "which couple, which identity."
 */
export async function authenticate(
	request: Request,
	env: Env,
): Promise<AuthContext | null> {
	const token = bearerToken(request);
	if (!token) return null;
	return authenticateToken(token, env);
}

/**
 * Token-form of {@link authenticate}, for callers that can't use the
 * `Authorization` header — the browser WebSocket API can't set headers, so the
 * `/api/ws` upgrade carries its bearer token in the query string instead.
 */
export async function authenticateToken(
	token: string,
	env: Env,
): Promise<AuthContext | null> {
	const hash = await credentialHashOf(token);
	const db = getRoutingDb(env.DB);
	const row = await db
		.select()
		.from(credentials)
		.where(
			and(eq(credentials.credentialHash, hash), isNull(credentials.revokedAt)),
		)
		.get();

	if (!row) return null;
	return {
		identityHash: row.identityHash,
		coupleDoId: row.coupleDoId,
		credentialHash: row.credentialHash,
		kind: row.kind,
	};
}

/** Convenience: authenticate and hand back the couple DO stub in one step. */
export async function authenticateWithStub(request: Request, env: Env) {
	const auth = await authenticate(request, env);
	if (!auth) return null;
	return { auth, stub: coupleStubById(env, auth.coupleDoId) };
}
