import type { z } from "zod";

/** JSON response with the right content type (plus any extra headers). */
export function json(
	data: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/** Error response in a consistent `{ error }` shape. */
export function errorResponse(message: string, status: number): Response {
	return json({ error: message }, status);
}

/**
 * Parses and validates a JSON request body against a zod schema. Returns the
 * parsed value, or a 400 Response describing what was wrong.
 */
export async function readJson<T>(
	request: Request,
	schema: z.ZodType<T>,
): Promise<{ data: T } | { response: Response }> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return { response: errorResponse("invalid JSON body", 400) };
	}
	const result = schema.safeParse(body);
	if (!result.success) {
		return {
			response: errorResponse(
				result.error.issues[0]?.message ?? "invalid body",
				400,
			),
		};
	}
	return { data: result.data };
}
