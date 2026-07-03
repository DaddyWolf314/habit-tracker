/**
 * Domain error codes for CoupleDO RPC. Durable Object RPC preserves an Error's
 * message across the stub boundary but not custom properties, so we encode the
 * code as a `CODE: message` prefix and let the API router map it to an HTTP
 * status (see src/worker/api/router.ts).
 */
export type CoupleErrorCode =
	| "BAD_REQUEST"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "CONFLICT"
	| "GONE";

export function coupleError(code: CoupleErrorCode, message: string): Error {
	return new Error(`${code}: ${message}`);
}

const STATUS: Record<CoupleErrorCode, number> = {
	BAD_REQUEST: 400,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	GONE: 410,
};

/** Splits a thrown error message back into an HTTP status + clean message. */
export function statusFromError(error: unknown): {
	status: number;
	message: string;
} {
	const raw = error instanceof Error ? error.message : String(error);
	const match = raw.match(/^([A-Z_]+):\s*(.*)$/);
	if (match && match[1] in STATUS) {
		return { status: STATUS[match[1] as CoupleErrorCode], message: match[2] };
	}
	return { status: 500, message: "internal error" };
}
