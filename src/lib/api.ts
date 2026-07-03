import type {
	CoupleExport,
	CoupleStatus,
	CreateIdentityResult,
	Device,
	InviteResult,
	MintDeviceResult,
	RoleAssignment,
	RoleConfirmationState,
	Session,
} from "#/shared/identity.ts";
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

export function mintDevice(label?: string): Promise<MintDeviceResult> {
	return apiFetch<MintDeviceResult>("/api/devices", {
		method: "POST",
		body: { label },
	});
}

export function listDevices(): Promise<{ devices: Device[] }> {
	return apiFetch<{ devices: Device[] }>("/api/devices");
}

export function revokeDevice(deviceId: string): Promise<{ ok: true }> {
	return apiFetch<{ ok: true }>("/api/devices/revoke", {
		method: "POST",
		body: { device_id: deviceId },
	});
}

/** Partner A mints a pairing invite. */
export function createInvite(): Promise<InviteResult> {
	return apiFetch<InviteResult>("/api/invites", { method: "POST" });
}

/** Partner B redeems an invite with a freshly generated secret. */
export function redeemInvite(
	code: string,
	bearer: string,
): Promise<CreateIdentityResult> {
	return apiFetch<CreateIdentityResult>("/api/invites/redeem", {
		method: "POST",
		body: { code },
		bearer,
	});
}

export function getRoles(): Promise<RoleConfirmationState> {
	return apiFetch<RoleConfirmationState>("/api/roles");
}

export function proposeRoles(
	assignment: RoleAssignment,
): Promise<RoleConfirmationState> {
	return apiFetch<RoleConfirmationState>("/api/roles/propose", {
		method: "POST",
		body: { assignment },
	});
}

export function confirmRoles(): Promise<RoleConfirmationState> {
	return apiFetch<RoleConfirmationState>("/api/roles/confirm", {
		method: "POST",
	});
}

/** Export the caller's own view of the relationship. */
export function exportData(): Promise<CoupleExport> {
	return apiFetch<CoupleExport>("/api/export");
}

/** Unilaterally dissolve the pairing (freezes the dynamic). */
export function dissolve(): Promise<{ status: CoupleStatus }> {
	return apiFetch<{ status: CoupleStatus }>("/api/dissolve", {
		method: "POST",
	});
}
