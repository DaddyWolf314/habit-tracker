import type { CreateIdentityResult, Session } from "#/shared/identity.ts";
import { getBearer } from "./identity.ts";

/**
 * Thin client for the Worker JSON API. Attaches the bearer credential and
 * throws {@link ApiError} on non-2xx so callers (and TanStack Query) can react
 * to status codes.
 */
export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

interface ApiOptions {
	method?: string;
	body?: unknown;
	/** Bearer to use instead of the stored secret (e.g. a just-generated one). */
	bearer?: string | null;
}

export async function apiFetch<T>(
	path: string,
	options: ApiOptions = {},
): Promise<T> {
	const bearer = options.bearer !== undefined ? options.bearer : getBearer();
	const headers: Record<string, string> = {};
	if (options.body !== undefined) headers["content-type"] = "application/json";
	if (bearer) headers.Authorization = `Bearer ${bearer}`;

	const response = await fetch(path, {
		method: options.method ?? "GET",
		headers,
		body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
	});

	const text = await response.text();
	const data = text ? JSON.parse(text) : null;
	if (!response.ok) {
		throw new ApiError(response.status, data?.error ?? response.statusText);
	}
	return data as T;
}

/** Creates the couple with a freshly generated secret (Partner A). */
export function createIdentity(bearer: string): Promise<CreateIdentityResult> {
	return apiFetch<CreateIdentityResult>("/api/identity", {
		method: "POST",
		bearer,
	});
}

export function getSession(): Promise<Session> {
	return apiFetch<Session>("/api/session");
}
